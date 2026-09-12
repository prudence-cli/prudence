-- 006_refusal_detail.sql — refusal diagnostics (live-fire follow-up).
-- Alternating budget/loop verdicts were observed on live traffic that the
-- serial thrash test cannot reproduce. Every refusal now carries its
-- consecutive-strike count and daemon pid so the rows explain themselves.

ALTER TABLE refusal_events ADD COLUMN detail TEXT;
