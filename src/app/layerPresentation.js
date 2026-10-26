import { LayerPanel } from '../ui/layers.js';
import {
  LAYER_RECORD_SAMPLE,
  newestProvenancedRecord,
} from '../ui/layerProvenance.js';
import { governorRequestRender } from '../renderGovernor.js';
import { markDetectionSourcesChanged } from '../data/detection.js';
import { freshnessOf } from '../data/provenance.js';

/** Own the layer panel and application reactions to lifecycle activity. */
export class LayerPresentation {
  constructor(
    manager,
    {
      weatherClock,
      requestRender = governorRequestRender,
      invalidateDetection = markDetectionSourcesChanged,
    } = {},
  ) {
    this.manager = manager;
    this.weatherClock = weatherClock;
    this._panel = null;
    this.pendingVisible = false;
    // Newest gated envelope per layer, sampled on demand (see
    // _layerFreshness) and dropped whenever the layer reports new data.
    this._freshnessSamples = new Map();
    this._unsubscribe = manager.subscribeActivity((change) => {
      if (change.type === 'data-updated')
        this._freshnessSamples.delete(change.layerId);
      if (change.type === 'status') this.refresh();
      else if (change.type === 'destroy-all') this.destroy();
      else {
        const reason =
          change.type === 'data-updated'
            ? `layer-tick:${change.layerId}`
            : change.type === 'visibility-settled'
              ? 'layer-visibility'
              : change.type === 'params-settled'
                ? `layer-params:${change.layerId}`
                : null;
        if (!reason) return;
        requestRender(reason);
        if (change.type !== 'params-settled') invalidateDetection(reason);
      }
    });
  }
  get panel() {
    if (!this._panel)
      this._panel = new LayerPanel({
        weatherClock: this.weatherClock,
        getLayers: () => this.manager.getAll(),
        isEnabled: (id) => this.manager.isEnabled(id),
        setEnabled: (id, enabled, options) =>
          this.manager.setEnabled(id, enabled, options),
        setLayerParams: (id, params, options) =>
          this.manager.setLayerParams(id, params, options),
        getRowControls: (id) => {
          const module = this.manager.layers.get(id)?.module;
          try {
            return module?.getRowControls?.() || null;
          } catch (error) {
            console.warn(`[Data] ${id} getRowControls error:`, error);
            return null;
          }
        },
        hasRowControls: (id) =>
          typeof this.manager.layers.get(id)?.module?.getRowControls ===
          'function',
        getLayerFreshness: (id) => this._layerFreshness(id),
        subscribeRowControls: (id, listener) => {
          const module = this.manager.layers.get(id)?.module;
          module?.setRowControlsListener?.(listener);
          return () => module?.setRowControlsListener?.(null);
        },
        onHiddenRefresh: () => {
          this.pendingVisible = true;
        },
      });
    return this._panel;
  }
  /**
   * A layer's freshness right now, judged by the newest envelope in a
   * bounded sample of its gated analyst records — the same module seam
   * getRowControls uses. The sample is taken once and cached until the
   * layer reports new data; the state itself is recomputed from the
   * cached envelope on every read, so a layer whose feed died walks
   * LIVE → AGING → STALE → EXPIRED as its last records age, with no
   * further sampling. No records (or an unreadable layer) → null: the
   * panel shows no state rather than an invented one.
   * @param {string} id Catalog layer id.
   * @returns {'LIVE'|'AGING'|'STALE'|'EXPIRED'|null}
   */
  _layerFreshness(id) {
    if (!this._freshnessSamples.has(id)) {
      const module = this.manager.layers.get(id)?.module;
      let sample = null;
      try {
        const records = module?.getAnalystRecords?.(LAYER_RECORD_SAMPLE);
        if (Array.isArray(records) && records.length)
          sample = newestProvenancedRecord(records) || records[0];
      } catch (error) {
        console.warn(`[Data] ${id} getAnalystRecords error:`, error);
      }
      this._freshnessSamples.set(id, sample);
    }
    const sample = this._freshnessSamples.get(id);
    return sample ? freshnessOf(sample) : null;
  }
  mount(container) {
    this.panel.mount(container);
  }
  /** Hand the Recent Imagery readout factory to the panel (see LayerPanel). */
  attachRecentImagery(factory) {
    // Detaching never builds a panel that teardown already released.
    if (factory) this.panel.attachRecentImagery(factory);
    else this._panel?.attachRecentImagery(null);
  }
  refresh() {
    this._panel?._refreshTogglePanel();
  }
  flushVisible() {
    if (!this.pendingVisible) return;
    this.pendingVisible = false;
    this.refresh();
  }
  destroy() {
    this._panel?.destroy();
    this._panel = null;
    this._freshnessSamples.clear();
    this.pendingVisible = false;
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}
