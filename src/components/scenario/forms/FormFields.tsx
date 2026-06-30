interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface NumberFieldProps {
  label: string;
  value: number | "";
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  min?: number;
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}

interface CheckboxFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface TextareaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: TextFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <input
        type="text"
        className="input-base w-full text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  placeholder,
  min,
}: NumberFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <input
        type="number"
        className="input-base w-full text-sm"
        value={value}
        onChange={(event) =>
          onChange(
            event.target.value === ""
              ? undefined
              : Number.parseInt(event.target.value, 10) || 0,
          )
        }
        placeholder={placeholder}
        min={min}
      />
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: SelectFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <select
        className="input-base w-full text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CheckboxField({
  id,
  label,
  checked,
  onChange,
}: CheckboxFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="w-4 h-4"
      />
      <label htmlFor={id} className="text-xs font-semibold text-primary">
        {label}
      </label>
    </div>
  );
}

export function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 6,
  className = "input-base w-full font-mono text-xs",
}: TextareaFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <textarea
        className={className}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
