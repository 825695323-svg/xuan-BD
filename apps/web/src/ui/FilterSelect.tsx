import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/** 采集源筛选下拉：沿用自绘触发器与选项列表，不复用系统原生 select。 */
export function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return <div className={`filter-select${open ? ' is-open' : ''}`}>
    <button type="button" className="filter-trigger" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <span className="filter-trigger-label">{label}</span>
      <span className="filter-trigger-value">{value}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="filter-options" role="listbox">
      {options.map((option) => <button type="button" key={option} className="filter-option" role="option"
        aria-selected={value === option} onClick={() => { onChange(option); setOpen(false); }}>
        {value === option && <Check size={13} aria-hidden="true" />}<span>{option}</span>
      </button>)}
    </div>}
  </div>;
}
