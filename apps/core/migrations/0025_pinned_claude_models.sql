-- The Claude options were the CLI's moving aliases (`opus`, `sonnet`), so a
-- saved default named no version and Settings could not show one. `probe.ts`
-- now offers pinned ids, and `judge()` matches a requested model against that
-- list exactly, so a default left under an alias would fail every Vesper turn
-- with `model_not_offered`. Carry it over to the model the alias resolved to.
UPDATE runtime_kv
SET value_json = json_set(
      value_json,
      '$.model',
      CASE json_extract(value_json, '$.model')
        WHEN 'opus' THEN 'claude-opus-5-5'
        ELSE 'claude-sonnet-5-5'
      END,
      '$.label',
      CASE json_extract(value_json, '$.model')
        WHEN 'opus' THEN 'Claude Opus 5.5'
        ELSE 'Claude Sonnet 5.5'
      END
    ),
    value_version = value_version + 1
WHERE key LIKE 'identity_model_default:%'
  AND json_extract(value_json, '$.providerId') = 'claude'
  AND json_extract(value_json, '$.model') IN ('opus', 'sonnet');
