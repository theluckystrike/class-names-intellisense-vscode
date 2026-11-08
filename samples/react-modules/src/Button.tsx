import React from 'react';
import clsx from 'clsx';
import styles from './Button.module.css';

type Props = { variant?: 'primary' | 'ghost'; loading?: boolean; iconOnly?: boolean; children: React.ReactNode };

export function Button({ variant = 'primary', loading, iconOnly, children }: Props) {
  return (
    <button
      className={clsx(styles.button, styles[variant], loading && styles.isLoading, iconOnly && styles['icon-only'])}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Toolbar() {
  return <div className="toolbar ">{/* global classes from app.css */}</div>;
}

const x = styles.
