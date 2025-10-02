import 'antd/dist/reset.css';
import './globals.css';

export const metadata = {
  title: 'Homework Helper | AI Study Coach',
  description: 'Personalised homework guidance for primary and secondary students.',
  icons: {
    icon: '/favicon.png',
    shortcut: '/favicon.png',
    apple: '/icon.png',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
