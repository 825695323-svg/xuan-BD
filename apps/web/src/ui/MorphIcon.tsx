import { MorphIcon as EngineMorphIcon, type MorphIconProps } from 'morphicons/react';
import { MORPH_ICONS, type MorphIconName } from './morph-icons';

export type { MorphIconName };

type Props = Omit<MorphIconProps, 'icon' | 'from' | 'to'> & { name: MorphIconName };

export function MorphIcon({ name, ...props }: Props) {
  return <EngineMorphIcon icon={MORPH_ICONS[name]} reducedMotion="user" {...props} />;
}
