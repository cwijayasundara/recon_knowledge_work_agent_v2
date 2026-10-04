import { useEffect, useState } from "preact/hooks";
import type { RunState, RunStore } from "../state/store";

export function useStore(store: RunStore): RunState {
  const [state, setState] = useState(store.get());
  useEffect(() => {
    setState(store.get());
    return store.subscribe(() => setState(store.get()));
  }, [store]);
  return state;
}
