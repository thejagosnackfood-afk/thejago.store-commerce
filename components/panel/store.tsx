"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  demoProducts,
  demoHistory,
  stockProducts,
  type Product,
  type StockChange,
} from "../../lib/panel-data";

type State = {
  products: Product[];
  stocks: Product[];
  history: StockChange[];
  monitor: boolean;
  returns: boolean;
  frames: Record<string, number>;
  boost: boolean[];
  queue: string[];
};
const initial: State = {
  products: demoProducts,
  stocks: stockProducts,
  history: demoHistory,
  monitor: true,
  returns: false,
  frames: {},
  boost: [true, true],
  queue: demoProducts.slice(5, 15).map((p) => p.id),
};
const Context = createContext<{
  state: State;
  update: (fn: (s: State) => State) => void;
  ready: boolean;
  storageError: boolean;
} | null>(null);
export function PanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("komplace-demo-v1");
      if (raw) {
        const value = JSON.parse(raw);
        if (
          value &&
          Array.isArray(value.products) &&
          Array.isArray(value.stocks) &&
          Array.isArray(value.history) &&
          Array.isArray(value.queue) &&
          Array.isArray(value.boost) &&
          value.frames &&
          typeof value.monitor === "boolean" &&
          typeof value.returns === "boolean"
        )
          setState(value);
      }
    } catch {
      setStorageError(true);
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready)
      try {
        localStorage.setItem("komplace-demo-v1", JSON.stringify(state));
      } catch {
        setStorageError(true);
      }
  }, [state, ready]);
  return (
    <Context.Provider value={{ state, update: setState, ready, storageError }}>
      {children}
    </Context.Provider>
  );
}
export function usePanel() {
  const value = useContext(Context);
  if (!value) throw new Error("PanelProvider required");
  return value;
}
