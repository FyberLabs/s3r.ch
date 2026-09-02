"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type Ground = "dark" | "light";
export type Reader = "human" | "ai";

export const DEFAULT_GROUND: Ground = "dark";
export const DEFAULT_READER: Reader = "human";

const GROUND_KEY = "s3rch-ground";
const READER_KEY = "s3rch-reader";

type BrandValue = {
  ground: Ground;
  reader: Reader;
  setGround: (ground: Ground) => void;
  setReader: (reader: Reader) => void;
};

const BrandContext = createContext<BrandValue | null>(null);

function isGround(value: string | null): value is Ground {
  return value === "dark" || value === "light";
}

function isReader(value: string | null): value is Reader {
  return value === "human" || value === "ai";
}

function applyBrand(ground: Ground, reader: Reader) {
  const root = document.documentElement;
  root.dataset.ground = ground;
  root.dataset.reader = reader;
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const [ground, setGroundState] = useState<Ground>(DEFAULT_GROUND);
  const [reader, setReaderState] = useState<Reader>(DEFAULT_READER);
  const groundRef = useRef<Ground>(ground);
  const readerRef = useRef<Reader>(reader);

  useEffect(() => {
    const storedGround = localStorage.getItem(GROUND_KEY);
    const storedReader = localStorage.getItem(READER_KEY);
    const nextGround = isGround(storedGround) ? storedGround : DEFAULT_GROUND;
    const nextReader = isReader(storedReader) ? storedReader : DEFAULT_READER;
    groundRef.current = nextGround;
    readerRef.current = nextReader;
    setGroundState(nextGround);
    setReaderState(nextReader);
    applyBrand(nextGround, nextReader);
  }, []);

  const setGround = useCallback((next: Ground) => {
    groundRef.current = next;
    setGroundState(next);
    localStorage.setItem(GROUND_KEY, next);
    applyBrand(next, readerRef.current);
  }, []);

  const setReader = useCallback((next: Reader) => {
    readerRef.current = next;
    setReaderState(next);
    localStorage.setItem(READER_KEY, next);
    applyBrand(groundRef.current, next);
  }, []);

  return (
    <BrandContext.Provider value={{ ground, reader, setGround, setReader }}>
      {children}
    </BrandContext.Provider>
  );
}

export function useBrand(): BrandValue {
  const value = useContext(BrandContext);
  if (value === null) {
    throw new Error("useBrand must be used within BrandProvider");
  }
  return value;
}

function AxisToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex border border-rule" role="group">
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            className={
              active
                ? "bg-signal px-2 py-1 text-[0.7rem] text-on-signal"
                : "bg-transparent px-2 py-1 text-[0.7rem] text-ink-muted hover:text-ink"
            }
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function BrandControls({ className = "" }: { className?: string }) {
  const { ground, reader, setGround, setReader } = useBrand();

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <AxisToggle
        value={ground}
        onChange={setGround}
        options={[
          { id: "dark", label: "Dark" },
          { id: "light", label: "Paper" },
        ]}
      />
      <AxisToggle
        value={reader}
        onChange={setReader}
        options={[
          { id: "human", label: "Human" },
          { id: "ai", label: "AI" },
        ]}
      />
    </div>
  );
}
