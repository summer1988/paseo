import { memo, type ReactNode } from "react";
import { Text, type StyleProp, type TextProps, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { fileMentionRuns, type FileMentionRun } from "@/utils/file-mention-autocomplete";

type FileMentionSurface = "bubble" | "composer";

export const FileMentionText = memo(function FileMentionText({
  text,
  surface,
  style,
  ...textProps
}: TextProps & {
  text: string;
  surface: FileMentionSurface;
  style?: StyleProp<TextStyle>;
}) {
  const runs = fileMentionRuns(text);
  if (!runs) {
    return (
      <Text style={style} {...textProps}>
        {text}
      </Text>
    );
  }
  const chipStyle = surface === "bubble" ? styles.chipOnBubble : styles.chipOnComposer;
  const pathStyle = surface === "bubble" ? styles.pathOnBubble : styles.pathOnComposer;
  const pieces: ReactNode[] = [];
  let chip: Array<Extract<FileMentionRun, { kind: "pad" | "path" }>> = [];
  let chipCount = 0;
  const flushChip = () => {
    if (chip.length === 0) return;
    const parts = chip;
    chip = [];
    const children: ReactNode[] = [];
    for (const part of parts) {
      if (part.kind !== "path") {
        children.push(part.text);
        continue;
      }
      children.push(
        <Text key={part.text} style={pathStyle} testID="file-mention">
          {part.text}
        </Text>,
      );
    }
    chipCount += 1;
    pieces.push(
      <Text
        key={`${chipCount}:${parts.map((part) => `${part.kind}:${part.text}`).join("|")}`}
        style={chipStyle}
      >
        {children}
      </Text>,
    );
  };
  for (const run of runs) {
    if (run.kind === "text") {
      flushChip();
      pieces.push(run.text);
      continue;
    }
    chip.push(run);
  }
  flushChip();
  return (
    <Text style={style} {...textProps}>
      {pieces}
    </Text>
  );
});

function mentionTint(hex: string): string {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, 0.18)`;
}

const styles = StyleSheet.create((theme) => ({
  chipOnBubble: {
    color: "transparent",
    backgroundColor: mentionTint(theme.colors.terminal.blue),
    borderRadius: theme.borderRadius.sm,
  },
  pathOnBubble: {
    color: theme.colors.terminal.brightBlue,
  },
  chipOnComposer: {
    color: "transparent",
    backgroundColor: mentionTint(theme.colors.terminal.blue),
    borderRadius: theme.borderRadius.sm,
  },
  pathOnComposer: {
    color: theme.colors.terminal.brightBlue,
  },
}));
