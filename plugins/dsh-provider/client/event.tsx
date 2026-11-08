import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { ScrollView, Text } from "react-native";

export function DshEvent({
  item,
  theme,
}: PluginTimelineItemProps<{ type: string; data: unknown }>) {
  const style = useMemo(
    () => ({
      color: theme.colors.foreground,
      fontFamily: "monospace" as const,
      fontSize: 12,
    }),
    [theme],
  );
  return (
    <ScrollView>
      <Text style={style}>{item.data.type}</Text>
      <Text style={style}>{JSON.stringify(item.data.data, null, 2)}</Text>
    </ScrollView>
  );
}
