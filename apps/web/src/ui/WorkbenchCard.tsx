import type { ComponentProps } from 'react';
import { Card } from './admin/card';
import './WorkbenchCard.css';

/** Shared research canvas / inspector frame; the business page owns the content. */
export function WorkbenchCard({ className, variant = 'canvas', ...props }: ComponentProps<typeof Card> & { variant?: 'canvas' | 'inspector' }) {
  return <Card {...props} data-workbench-card={variant} className={'workbench-card' + (className ? ` ${className}` : '')} />;
}
