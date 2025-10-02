'use client';

import { useState } from 'react';
import { LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import styles from './admin.module.css';

export const NAV_ITEMS = [
  {
    key: 'floppy',
    label: 'Floppy builder',
    hint: 'Create and preview floppy flows',
  },
  {
    key: 'sandbox',
    label: 'Sandbox builder',
    hint: 'Load a floppy into a RAG-powered agent',
  },
  {
    key: 'sandbox-manager',
    label: 'Sandbox manager',
    hint: 'Organise saved sandboxes and character cards',
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const navItems = NAV_ITEMS;
  const active = getNavItem(activePage);
  const displayName = user?.displayName || user?.userId || 'Administrator';

  const toggleSidebar = () => {
    setSidebarCollapsed((previous) => !previous);
  };

  return (
    <div className={styles.container}>
      <aside
        className={`${styles.sidebar} ${sidebarCollapsed ? styles.sidebarCollapsed : ''}`}
        aria-hidden={sidebarCollapsed}
      >
        <div className={styles.sidebarHeader}>
          <div className={styles.brand}>Homework admin</div>
          <button
            type="button"
            className={styles.sidebarToggle}
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!sidebarCollapsed}
            aria-controls="admin-navigation"
          >
            {sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </div>
        <nav id="admin-navigation" className={styles.nav}>
          {navItems.map((item) => {
            const isActive = item.key === active.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`${styles.navButton} ${isActive ? styles.navButtonActive : ''}`}
                onClick={() => onSelectPage?.(item.key)}
              >
                <span>{item.label}</span>
                <div className={styles.navHint}>
                  {item.hint}
                </div>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.topbarTitleGroup}>
            <button
              type="button"
              className={styles.sidebarTrigger}
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-expanded={!sidebarCollapsed}
              aria-controls="admin-navigation"
            >
              {sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </button>
            <div className={styles.topbarTitle}>{active.label}</div>
          </div>
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
        </header>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
