import { useEffect, useMemo, useRef } from "react";

type PinEntryProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
};

function clampDigits(input: string, length: number) {
  return input.replace(/\D/g, "").slice(0, length);
}

export function PinEntry({
  value,
  onChange,
  onSubmit,
  length = 10,
  disabled = false,
  autoFocus = false,
}: PinEntryProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const normalized = useMemo(() => clampDigits(value, length), [value, length]);

  useEffect(() => {
    if (!autoFocus || disabled) {
      return;
    }
    refs.current[0]?.focus();
  }, [autoFocus, disabled]);

  const setAtIndex = (index: number, digit: string) => {
    const chars = normalized.split("");
    chars[index] = digit;
    const next = clampDigits(chars.join(""), length);
    onChange(next);
  };

  const clearAtIndex = (index: number) => {
    const chars = normalized.split("");
    chars[index] = "";
    onChange(clampDigits(chars.join(""), length));
  };

  const focusIndex = (index: number) => {
    const target = Math.max(0, Math.min(length - 1, index));
    refs.current[target]?.focus();
    refs.current[target]?.select();
  };

  return (
    <div className="pin-entry">
      {Array.from({ length }).map((_, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          className="pin-entry-box"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={normalized[index] ?? ""}
          disabled={disabled}
          maxLength={1}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onChange={(event) => {
            const digit = event.currentTarget.value.replace(/\D/g, "");
            if (!digit) {
              clearAtIndex(index);
              return;
            }
            setAtIndex(index, digit[digit.length - 1]);
            if (index < length - 1) {
              focusIndex(index + 1);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (normalized.length >= 4) {
                event.preventDefault();
                onSubmit?.();
              }
              return;
            }
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              focusIndex(index - 1);
              return;
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              focusIndex(index + 1);
              return;
            }
            if (event.key !== "Backspace") {
              return;
            }
            event.preventDefault();
            if (normalized[index]) {
              clearAtIndex(index);
              return;
            }
            if (index > 0) {
              clearAtIndex(index - 1);
              focusIndex(index - 1);
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            const pastedDigits = clampDigits(event.clipboardData.getData("text"), length);
            if (!pastedDigits) {
              return;
            }
            const chars = normalized.split("");
            let cursor = index;
            for (const char of pastedDigits) {
              if (cursor >= length) {
                break;
              }
              chars[cursor] = char;
              cursor += 1;
            }
            const next = clampDigits(chars.join(""), length);
            onChange(next);
            focusIndex(Math.min(cursor, length - 1));
          }}
        />
      ))}
    </div>
  );
}
