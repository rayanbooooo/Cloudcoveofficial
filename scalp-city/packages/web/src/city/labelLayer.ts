import { createContext, useContext, type RefObject } from 'react';

/**
 * DOM layer for the city's HTML labels. drei's <Html> otherwise mounts into
 * the canvas wrapper, which R3F swaps once its event system connects; any
 * label that did not re-render after that swap (e.g. the vault, which
 * changes only when the account does) stayed blank. A stable target fixes it.
 */
export const LabelLayer = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useLabelLayer(): RefObject<HTMLElement> | undefined {
  return (useContext(LabelLayer) ?? undefined) as RefObject<HTMLElement> | undefined;
}
