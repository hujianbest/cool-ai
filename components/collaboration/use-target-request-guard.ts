"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

export type TargetRequest = {
  epoch: number;
  isCurrent: () => boolean;
  key: string;
  signal: AbortSignal;
};

type GuardState = {
  controller: AbortController;
  epoch: number;
  key: string;
  mounted: boolean;
};

export function useTargetRequestGuard(targetKey: string) {
  const stateRef = useRef<GuardState | null>(null);
  if (!stateRef.current) {
    stateRef.current = {
      controller: new AbortController(),
      epoch: 0,
      key: targetKey,
      mounted: false,
    };
  } else if (stateRef.current.key !== targetKey) {
    stateRef.current.controller.abort();
    stateRef.current = {
      controller: new AbortController(),
      epoch: stateRef.current.epoch + 1,
      key: targetKey,
      mounted: stateRef.current.mounted,
    };
  }

  useEffect(() => {
    const state = stateRef.current!;
    state.mounted = true;
    if (state.controller.signal.aborted) {
      state.controller = new AbortController();
      state.epoch += 1;
    }
    return () => {
      state.mounted = false;
      state.controller.abort();
      state.epoch += 1;
    };
  }, []);

  const capture = useCallback((): TargetRequest => {
    const state = stateRef.current!;
    const epoch = state.epoch;
    const key = state.key;
    const signal = state.controller.signal;
    return {
      epoch,
      key,
      signal,
      isCurrent: () => {
        const current = stateRef.current!;
        return current.mounted
          && !signal.aborted
          && current.epoch === epoch
          && current.key === key;
      },
    };
  }, []);

  return useMemo(() => ({ capture }), [capture]);
}
