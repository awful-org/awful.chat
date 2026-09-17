import { MAX_CHAT_CONTENT_LENGTH, MAX_MESSAGE_FILES } from "./verify-incoming";

/** Validate the final wire text (after mention expansion), never silently truncate. */
export function prepareOutgoingText(text: string, files: File[] = []): { text: string; files: File[] } {
  const oversized = text.length > MAX_CHAT_CONTENT_LENGTH;
  if (files.length + Number(oversized) > MAX_MESSAGE_FILES) {
    throw new Error(`A message can have at most ${MAX_MESSAGE_FILES} files. Long text needs one attachment slot; remove a file or send the text separately.`);
  }
  if (!oversized) return { text, files };
  return {
    text: "Long message attached as message.txt",
    files: [...files, new File([text], "message.txt", { type: "text/plain;charset=utf-8" })],
  };
}
