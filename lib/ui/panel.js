// panel.js — the extra subagent-switch panel
//
// The user chose "额外面板" (extra panel). This module defines the panel
// contract: title, model list, status column, default-model field, routing
// table, blacklist, and a refresh action. Actual mounting happens in the
// browser half (lib/ui/client.js), which registers a slot with the host UI.
// We keep the pure rendering data structures host-agnostic here, so the panel
// logic is testable without a browser.
//
// Host contract (browser half):
//   SubagentSwitchPanel.render()            — panel content as a plain object.
//   SubagentSwitchPanel.refresh(router)     — force a re-read of the model list.
//   SubagentSwitchPanel.onManualSelect(name) — UI callback for manual choice.
//   SubagentSwitchPanel.onToggleExcluded(name, enabled)

export class SubagentSwitchPanel {
  constructor(opts) {
    this.opts = opts || {};
    this.title = this.opts.panelTitle || "子代理模型切换";
    this.visible = Boolean(this.opts.panelVisibleByDefault);
    this.modelList = [];
    this.status = "ready"; // ready | loading | error
    this.error = "";
    this.dirty = false;
  }

  /** Refresh from the router. */
  async refresh(router) {
    if (!router) {
      this.status = "error";
      this.error = "router missing: panel cannot read model list";
      return;
    }
    try {
      await router.refreshModels();
      this.modelList = router.models || [];
      this.status = "ready";
      this.error = "";
    } catch (err) {
      this.status = "error";
      this.error = err?.message || String(err);
    }
    this.dirty = false;
  }

  /** Full model record for rendering one row. */
  row(model) {
    const statusLabel =
      model.status === "available"
        ? "可用"
        : model.status === "excluded"
        ? "黑名单"
        : model.status === "unavailable"
        ? "目录不可见"
        : "额度用尽";

    const tierLabel = model.rawTier || "未知";
    const remaining = model.remainingCredit;
    const quotaText =
      remaining === undefined || remaining === -1
        ? "未知"
        : remaining === 0
        ? "用尽"
        : `剩余 ${remaining}`;

    return {
      name: model.name,
      provider: model.provider || "",
      tier: tierLabel,
      status: statusLabel,
      goodAt: model.goodAt || [],
      badAt: model.badAt || [],
      quota: quotaText,
      diagnostic: model.__diagnostic__
    };
  }

  /** Plain-object representation used by the UI to render. */
  render() {
    const rows = (this.modelList || []).map((m) => this.row(m));
    return {
      title: this.title,
      status: this.status,
      error: this.error,
      dirty: this.dirty,
      rows,
      defaultModel: this.opts.defaultModel || "",
      routingTable: (this.opts.routingTable || []).map((r) => ({
        category: r.category || "general",
        defaultModel: r.defaultModel || ""
      })),
      blacklist: this.opts.blacklist || [],
      autoFallback: Boolean(this.opts.quota?.autoFallbackOnExhaustion)
    };
  }

  /** UI callback hook: called when the user picks a model manually. */
  onManualSelect(name) {
    logPanel("manualSelect", name);
  }

  /** UI callback hook: blacklist toggle. */
  onToggleExcluded(name, enabled) {
    logPanel("toggleExcluded", name, enabled);
  }

  setVisible(v) {
    this.visible = Boolean(v);
  }
}

function logPanel(source, ...args) {
  const ts = new Date().toISOString();
  console.log(`[subagent-switch panel] ${ts} ${source} ${JSON.stringify(args)}`);
}
