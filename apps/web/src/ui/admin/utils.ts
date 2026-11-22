/* Shadcn Admin e16c87f213a5ba5e45964e9b67c792105ec74d26: src/lib/utils.ts. MIT; see public/licenses/shadcn-admin-MIT.txt. */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
