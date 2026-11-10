import type { Row } from "../shared/sessionNav";

export function previewContent(row: Row | null) {
  if (!row) return { subtitle: "", sections: [], metadata: "" };
  const message = row.kind === "user" || row.kind === "assistant";
  const hidden = row.status === "hidden";
  const sections: Array<{ label: string; text: string }> = [];
  if (hidden) {
    sections.push({
      label: row.summary_pending ? "Sent to model · summary pending" : "Sent to model",
      text: message ? "Removed from context" : row.replacement_text ?? "Replacement unavailable",
    });
  }
  if (message) {
    sections.push({ label: hidden ? "Original message" : "Message", text: row.message_text ?? row.summary_line ?? "Message unavailable" });
  } else if (row.tool_input !== undefined || row.tool_output !== undefined) {
    sections.push(
      { label: hidden ? "Original input" : "Input", text: row.tool_input ?? "Input unavailable" },
      { label: hidden ? "Original output" : "Output", text: row.tool_output ?? "Output unavailable" },
    );
  } else {
    sections.push({ label: "Details", text: row.summary_line ?? "No details available" });
  }
  if (row.manageable === false) sections.push({ label: "Read-only", text: "Display-only item; context controls unavailable." });
  return {
    subtitle: row.tool_name || row.kind || "Item",
    sections,
    metadata: [row.item_id || row.tool_call_id || "No ID", `v${row.version}`, row.source ?? "timeline", row.tokens_display].join(" · "),
  };
}
