/**
 * The fictional world's fixed ids, shared by every LARP area so a file root,
 * a node and a thread all point at the same machine.
 */
export const LARP_IDS = {
  homeNode: "01a05c32-5e80-7208-b379-6be0ea7e7440",
  workNode: "01a05c32-6268-7bb3-8ea8-bdf01e4b8b7a",
  phoneNode: "01a05c32-6650-71cf-9c45-241c7821e154",
  /** Folder grants: Projects on Home PC, Documents on Work PC. */
  homeProjectsGrant: "01a05c32-6a38-7d48-9a6c-6f870f17d2df",
  workDocumentsGrant: "01a05c32-6e20-7df3-8f8a-d7b7bd466e3e",
  vesperThread: "01a05c32-7208-797b-a748-83607258daa4",
  jesterThread: "01a05c32-75f0-7296-ab05-58adc8e575fb",
  demoTaskThread: "01a05c32-79d8-7b53-b509-ff2ea1738ca8",
} as const;
