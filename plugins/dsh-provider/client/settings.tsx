import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { chooseAttachInstall } from "../shared/choose-attach.js";
import { attachInstall, listInstalls, type DshInstall } from "../shared/contract.js";
import { dshSettings } from "../shared/settings.js";

export function DshSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(dshSettings);
  const loadInstalls = useRpc(listInstalls);
  const attach = useRpc(attachInstall);
  const [installs, setInstalls] = useState<DshInstall[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [link, setLink] = useState("");
  const padding = layout.compact ? 16 : 24;
  const styles = useMemo(
    () => ({
      screen: { backgroundColor: theme.colors.surface0, padding, gap: 12 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      body: { color: theme.colors.foregroundMuted, fontSize: 14 },
      card: {
        gap: 8,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface1,
      },
      label: { color: theme.colors.foreground, fontSize: 16 },
      button: {
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
      quiet: { paddingVertical: 10, paddingHorizontal: 12 },
      input: {
        color: theme.colors.foreground,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
      },
      stack: { gap: 8 },
    }),
    [layout.compact, padding, theme],
  );

  const refresh = useCallback(async () => {
    try {
      setInstalls((await loadInstalls({})).installs);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not list installs");
    }
  }, [loadInstalls]);

  const search = useCallback(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addFromBrowser = useCallback(async () => {
    if (settings.status !== "ready") {
      setError("DeepSeek Harness settings are still loading.");
      return;
    }
    const loginUrl = link.trim();
    if (!loginUrl) {
      setError("Paste the loopback address from the browser.");
      return;
    }
    try {
      const found = installs ?? (await loadInstalls({})).installs;
      setInstalls(found);
      const choice = chooseAttachInstall(found, settings.values.installId);
      if ("error" in choice) {
        setError(choice.error);
        return;
      }
      await attach({ installId: choice.install.id, loginUrl });
      setLink("");
      const saved = await settings.save(
        { installId: choice.install.id, mode: "attach" },
        settings.revision,
      );
      if (!saved) setError(settings.saveError ?? "Could not save the selection");
      else setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not use that address");
    }
  }, [attach, installs, link, loadInstalls, settings]);

  const add = useCallback(() => {
    void addFromBrowser();
  }, [addFromBrowser]);

  const choose = useCallback(
    async (install: DshInstall, mode: "build" | "attach") => {
      if (settings.status !== "ready") return;
      if (mode === "attach") {
        const loginUrl = link.trim();
        if (!loginUrl) {
          setError("Paste the loopback address from the browser.");
          return;
        }
        try {
          await attach({ installId: install.id, loginUrl });
          setLink("");
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "Could not use that client");
          return;
        }
      }
      const saved = await settings.save({ installId: install.id, mode }, settings.revision);
      if (!saved) setError(settings.saveError ?? "Could not save the selection");
    },
    [attach, link, settings],
  );

  return (
    <View style={styles.screen} testID="dsh-client-setup">
      <Text style={styles.title}>DeepSeek Harness</Text>
      <Text style={styles.body}>
        Choose an installed official client or DSH NEXT. Build starts a host from that install. Use
        connects to a client that is already running.
      </Text>
      <View style={styles.card}>
        <Text style={styles.label}>Add from browser address</Text>
        <Text style={styles.body}>
          Paste the loopback address from the browser address bar. Paseo exchanges it immediately
          and does not save the address. The login stays on this computer, so a Paseo restart
          reconnects. Paste a new address after the host itself restarts.
        </Text>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="http://127.0.0.1:port/?token=…"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          style={styles.input}
        />
        <Pressable accessibilityRole="button" onPress={add} style={styles.button}>
          <Text style={styles.buttonText}>Add this address</Text>
        </Pressable>
      </View>
      {settings.status === "ready" && settings.values.installId ? (
        <Text style={styles.body}>
          Saved {settings.values.mode === "attach" ? "direct use" : "build"} for{" "}
          {installs?.find((install) => install.id === settings.values.installId)?.label ??
            settings.values.installId}
          .
          {settings.values.mode === "attach"
            ? " The browser address is not kept. This computer reconnects with the saved login."
            : ""}
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={search} style={styles.button}>
        <Text style={styles.buttonText}>Find installed clients</Text>
      </Pressable>
      {error ? <Text style={styles.body}>{error}</Text> : null}
      {installs?.length === 0 ? (
        <Text style={styles.body}>
          Nothing found. Install DeepSeek Harness or DSH NEXT on this computer, then search again.
        </Text>
      ) : null}
      {installs?.map((install) => (
        <InstallCard
          key={install.id}
          install={install}
          link={link}
          onLink={setLink}
          onChoose={choose}
          placeholder={theme.colors.foregroundMuted}
          styles={styles}
        />
      ))}
    </View>
  );
}

function InstallCard({
  install,
  link,
  onLink,
  onChoose,
  placeholder,
  styles,
}: {
  install: DshInstall;
  link: string;
  onLink(value: string): void;
  onChoose(install: DshInstall, mode: "build" | "attach"): Promise<void>;
  placeholder: string;
  styles: {
    card: object;
    label: object;
    body: object;
    button: object;
    buttonText: object;
    quiet: object;
    input: object;
    stack: object;
  };
}) {
  const build = useCallback(() => {
    void onChoose(install, "build");
  }, [install, onChoose]);
  const attach = useCallback(() => {
    void onChoose(install, "attach");
  }, [install, onChoose]);
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{install.label}</Text>
      <Text style={styles.body}>
        {install.version ?? "unknown version"} · {install.profile} · {install.home}
      </Text>
      {install.canBuild ? (
        <Pressable accessibilityRole="button" onPress={build} style={styles.button}>
          <Text style={styles.buttonText}>Build from this client</Text>
        </Pressable>
      ) : (
        <Text style={styles.body}>
          This install has no readable host entry, so it cannot build one.
        </Text>
      )}
      {install.attachAvailable ? (
        <View style={styles.stack}>
          <TextInput
            value={link}
            onChangeText={onLink}
            placeholder="http://127.0.0.1:port/?token=…"
            placeholderTextColor={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />
          <Pressable accessibilityRole="button" onPress={attach} style={styles.quiet}>
            <Text style={styles.label}>Use this running client</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.body}>{install.attachDisabledReason}</Text>
      )}
    </View>
  );
}
