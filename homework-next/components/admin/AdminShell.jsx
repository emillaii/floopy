'use client';

import { useState } from 'react';
import { LogoutOutlined, MenuOutlined, CloseOutlined } from '@ant-design/icons';
import styles from './admin.module.css';

export const NAV_ITEMS = [
  {
    key: 'floppy',
    label: 'Floppy builder',
    hint: 'Create and preview floppy flows',
  },
  {
    key: 'sandbox',
    label: 'Sandbox lab',
    hint: 'Build, test, and organise sandbox agents',
  },
];

function getNavItem(key) {
  return NAV_ITEMS.find((item) => item.key === key) || NAV_ITEMS[0];
}

function getInitials(input) {
  if (!input) return 'AD';
  const parts = String(input).trim().split(/\s+/).slice(0, 2);
  if (!parts.length) return 'AD';
  return parts.map((part) => part[0]?.toUpperCase() || '').join('');
}

export default function AdminShell({
  user,
  activePage,
  onSelectPage,
  onLogout,
  children,
}) {
  const [navOpen, setNavOpen] = useState(false);
  const navItems = NAV_ITEMS;
  const active = getNavItem(activePage);
  const displayName = user?.displayName || user?.userId || 'Administrator';

  const toggleNav = () => {
    setNavOpen((previous) => !previous);
  };

  const handleSelectPage = (key) => {
    onSelectPage?.(key);
    setNavOpen(false);
  };

  return (
    <div className={styles.container}>
      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.brandBlock}>
            <div className={styles.brand}>Homework Funhouse</div>
            <span className={styles.brandTag}>Admin Playground</span>
          </div>
          <div className={styles.topbarControls}>
            <button
              type="button"
              className={styles.navToggle}
              onClick={toggleNav}
              aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={navOpen}
              aria-controls="admin-navigation"
            >
              {navOpen ? <CloseOutlined /> : <MenuOutlined />}
            </button>
            <div className={styles.userMenu}>
              <div className={styles.profile}>
                <div className={styles.profileAvatar}>{getInitials(displayName)}</div>
                <div>
                  <div className={styles.profileName}>{displayName}</div>
                  <div className={styles.profileRole}>Administrator</div>
                </div>
              </div>
              <button
                type="button"
                className={styles.logoutButton}
                onClick={onLogout}
                aria-label="Log out"
                title="Log out"
              >
                <LogoutOutlined aria-hidden="true" />
              </button>
            </div>
          </div>
        </header>

        <nav
          id="admin-navigation"
          className={`${styles.nav} ${navOpen ? styles.navOpen : ''}`}
          aria-label="Admin sections"
        >
          {navItems.map((item) => {
            const isActive = item.key === active.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`${styles.navButton} ${isActive ? styles.navButtonActive : ''}`}
                onClick={() => handleSelectPage(item.key)}
              >
                <span className={styles.navLabel}>{item.label}</span>
                <span className={styles.navHint}>{item.hint}</span>
              </button>
            );
          })}
        </nav>

        <main className={styles.content}>
          <div className={styles.pageHeader}>
            <h1 className={styles.pageTitle}>{active.label}</h1>
            <p className={styles.pageHint}>{active.hint}</p>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
