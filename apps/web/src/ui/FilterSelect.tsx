import { Check, ChevronDown } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useCanvasContainer } from './canvas';

/** 采集源筛选复用受控浮层：交给 Radix 处理边界避让、键盘导航及点击外部关闭。 */
export function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (value: string) => void;
}) {
  const canvas = useCanvasContainer();
  return <div className="filter-select">
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" className="filter-trigger" aria-label={label}>
        <span className="filter-trigger-label">{label}</span>
        <span className="filter-trigger-value">{value}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={canvas ?? undefined}>
        <DropdownMenu.Content className="filter-options ui-menu" align="start" sideOffset={6} collisionPadding={12}>
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => <DropdownMenu.RadioItem value={option} key={option} className="filter-option">
              <span className="filter-option-check"><DropdownMenu.ItemIndicator><Check size={13} aria-hidden="true" /></DropdownMenu.ItemIndicator></span>
              <span>{option}</span>
            </DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}
