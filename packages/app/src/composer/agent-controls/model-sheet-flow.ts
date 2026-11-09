import type { ModelBrowserView } from "@/components/model-browser-view";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

export function resolveModelSheetOpening({
  canSwitchProvider,
  providers,
  selectedProvider,
}: {
  canSwitchProvider: boolean;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
}): ModelBrowserView {
  if (canSwitchProvider || providers.length !== 1) return { kind: "all" };

  const provider = providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
  return provider
    ? { kind: "provider", providerId: provider.id, providerLabel: provider.label }
    : { kind: "all" };
}

/** A running chat can take a new model only from the provider that started it. */
export function acceptsModelSelection({
  nextProviderId,
  currentProvider,
  canRetarget,
}: {
  nextProviderId: string;
  currentProvider: string;
  canRetarget: boolean;
}): boolean {
  return canRetarget || nextProviderId === currentProvider;
}
