// The curation panel's Labels tab: this review's value for each grouping field.
// Shared by the room's Edit panel and — until it is deleted — the old curate
// page (docs/plan/14-rooms-models-admin-ai.md batch BH), so the values come in
// as a prop and the writes as `actions`: the two callers keep the review in
// different stores.

import React, { useEffect, useState } from 'react';
import { Tags } from 'lucide-react';
import { listUsedLabelValues } from '../../lib/curationsRepo';
// The field DEFINITIONS stay a direct store read on purpose: they are
// install-wide rather than per-review, so both callers want the same ones and
// there is nothing to inject.
import { useLabelFieldsStore } from '../../lib/labelFieldsStore';
import LabelFieldsSettings from '../UI/LabelFieldsSettings';
import type { ReviewDraftActions } from './draftActions';

export const LabelsTab: React.FC<{
  labels: Record<string, string>;
  actions: ReviewDraftActions;
}> = ({ labels, actions }) => {
  const fields = useLabelFieldsStore((s) => s.fields);
  const loadFields = useLabelFieldsStore((s) => s.load);
  const loaded = useLabelFieldsStore((s) => s.loaded);
  const [usedValues, setUsedValues] = useState<Record<string, string[]>>({});
  // The fields themselves are install-wide, so they are defined in the same
  // panel the tracker and the admin screen use — reachable from here too,
  // because "go to the tracker settings" is not an instruction anyone
  // should have to follow to fill in the tab they are already looking at.
  const [fieldSettingsOpen, setFieldSettingsOpen] = useState(false);

  useEffect(() => {
    if (!loaded) loadFields();
  }, [loaded, loadFields]);

  // What other reviews have already been tagged with, for the suggestions in
  // the free-text inputs. Once per mount: the point is to stop three
  // spellings of one phase becoming three groups, not to be live.
  useEffect(() => {
    let cancelled = false;
    void listUsedLabelValues().then((values) => {
      if (!cancelled) setUsedValues(values);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="p-5 flex flex-col gap-3">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Tag this review with values for each grouping field. The tracker uses these to organise sessions.
      </p>

      {fields.length === 0 && loaded && (
        <div className="text-center py-10 flex flex-col items-center gap-3 text-gray-500 text-xs italic">
          <Tags size={28} className="opacity-30" />
          No label fields yet
          <span className="text-[10px] text-gray-600 max-w-[240px] not-italic">
            A label field is how you group reviews — by phase, programme,
            product, whatever suits you. They are shared across the install.
          </span>
          <button
            onClick={() => setFieldSettingsOpen(true)}
            className="mt-1 px-3 py-1.5 rounded bg-white text-gray-900 text-[11px] font-bold not-italic hover:bg-gray-100 transition-colors"
          >
            Add a label field
          </button>
        </div>
      )}

      {fields.map((field) => {
        const currentValue = labels[field.id] ?? '';
        const hasValues = field.values.length > 0;
        return (
          <div key={field.id} className="rounded border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-300">{field.name}</span>
              {currentValue && (
                <button
                  onClick={() => actions.clearLabel(field.id)}
                  className="text-[10px] text-gray-500 hover:text-red-400 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            {hasValues ? (
              <select
                value={currentValue}
                onChange={(e) => {
                  if (e.target.value) {
                    actions.setLabel(field.id, e.target.value);
                  } else {
                    actions.clearLabel(field.id);
                  }
                }}
                className="w-full bg-white/5 text-xs rounded px-2 py-1.5 border border-white/10 outline-none focus:border-emerald-400/50 text-gray-200"
              >
                <option value="">— unset —</option>
                {field.values.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            ) : (
              <input
                value={currentValue}
                onChange={(e) => {
                  if (e.target.value) {
                    actions.setLabel(field.id, e.target.value);
                  } else {
                    actions.clearLabel(field.id);
                  }
                }}
                placeholder="Type a value…"
                list={`label-suggestions-${field.id}`}
                className="text-gray-100 w-full bg-white/5 text-xs rounded px-2 py-1.5 border border-white/10 outline-none focus:border-emerald-400/50 placeholder:text-gray-600"
              />
            )}
            {!hasValues && usedValues[field.id] && usedValues[field.id].length > 0 && (
              <datalist id={`label-suggestions-${field.id}`}>
                {usedValues[field.id].map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            )}
          </div>
        );
      })}

      {fields.length > 0 && (
        <button
          onClick={() => setFieldSettingsOpen(true)}
          className="self-start text-[10px] text-gray-500 hover:text-white transition-colors underline underline-offset-2"
        >
          Add or edit label fields
        </button>
      )}

      {fieldSettingsOpen && (
        <LabelFieldsSettings
          fields={fields}
          onClose={() => setFieldSettingsOpen(false)}
        />
      )}
    </div>
  );
};
