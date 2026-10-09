export function carriesFiles(transfer: { readonly types: readonly string[] } | null): boolean {
  return transfer?.types.includes("Files") ?? false;
}

/**
 * Left alone, a file dropped outside the composer replaces the whole app with
 * that file. Only a drag that carries files is stopped, so text can still be
 * dragged into a field.
 */
export function guardStrayFileDrops(target: EventTarget): () => void {
  const stop = (event: Event): void => {
    if (carriesFiles((event as DragEvent).dataTransfer)) {
      event.preventDefault();
    }
  };

  target.addEventListener("dragover", stop);
  target.addEventListener("drop", stop);

  return () => {
    target.removeEventListener("dragover", stop);
    target.removeEventListener("drop", stop);
  };
}
