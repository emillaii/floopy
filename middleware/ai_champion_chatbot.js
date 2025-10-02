#!/usr/bin/env node
// Interactive CLI for the AI Champion chatbot using the shared core runtime.

const readline = require('readline');
const { ChampionChatManager, parseBoolean } = require('./ai_champion_core');

function toOptionLabel(option) {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object') {
    if (option.label) return option.label;
    if (option.name && option.prompt) {
      const preview = option.prompt.length > 60 ? `${option.prompt.slice(0, 57)}...` : option.prompt;
      return `${option.name} – ${preview}`;
    }
    if (option.name) return option.name;
  }
  return String(option);
}

function askQuestion(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function selectOption(rl, title, options, getValue, defaultOption) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`No options provided for ${title}`);
  }
  if (options.length === 1) {
    return getValue(options[0]);
  }

  console.log(`\n${title}:`);
  options.forEach((opt, idx) => {
    console.log(`  [${idx + 1}] ${toOptionLabel(opt)}`);
  });

  const defaultIndex = defaultOption
    ? Math.max(0, options.findIndex((opt) => getValue(opt) === defaultOption))
    : 0;

  while (true) {
    const prompt = `Select ${title.toLowerCase()} (1-${options.length}) [${defaultIndex + 1}]: `;
    const answer = await askQuestion(rl, prompt);
    if (!answer) {
      return getValue(options[defaultIndex]);
    }
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return getValue(options[index - 1]);
    }
    console.log('Invalid selection. Please try again.');
  }
}

async function main() {
  const {
    CHAT_SESSION_ID,
    CHAT_NEW_SESSION_PER_RUN = 'false',
  } = process.env;

  const manager = new ChampionChatManager();
  await manager.init();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const userOptions = manager.listUsers();
  const userId = await selectOption(
    rl,
    'User',
    userOptions,
    (opt) => (typeof opt === 'string' ? opt : opt.userId),
    manager.defaultUser,
  );
  const personaName = await selectOption(rl, 'Persona', manager.listPersonas(), (opt) => opt.name, manager.defaultPersona);
  const persona = manager.getPersona(personaName);

  const session = manager.createSession({
    userId,
    personaName,
    sessionId: CHAT_SESSION_ID,
    newSessionPerRun: parseBoolean(CHAT_NEW_SESSION_PER_RUN),
  });

  console.log('\nAI Champion chatbot ready. Type your message, or `/exit` to quit.');
  console.log(`User: ${session.userId}`);
  console.log(`Persona: ${session.persona.name}`);
  console.log(`Session ID: ${session.sessionId}`);

  const promptUser = () => new Promise((resolve) => {
    rl.question('You > ', (line) => resolve(line.trim()));
  });

  let running = true;
  while (running) {
    const userInput = await promptUser();
    if (!userInput) continue;
    if (userInput.toLowerCase() === '/exit') {
      running = false;
      break;
    }

    try {
      const result = await session.sendMessage(userInput);
      console.log(`${result.persona.name} > ${result.reply}`);
    } catch (err) {
      console.error('Error while processing message:', err?.message || err);
    }
  }

  rl.close();
  console.log('Session ended.');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
