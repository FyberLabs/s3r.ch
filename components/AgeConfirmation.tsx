export const AGE_CONFIRMATION_LABEL = "I confirm that I am at least 18 years old";

type Props = {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

/** Shown only when this identity has not confirmed before. */
export function AgeConfirmation(props: Props) {
  return (
    <label className="mt-4 flex items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      {AGE_CONFIRMATION_LABEL}
    </label>
  );
}
