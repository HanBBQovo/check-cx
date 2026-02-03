-- =============================================================================
-- 迁移：可用性统计将 degraded 视为可用 (public schema)
--
-- 背景：
-- - check_history.status=degraded 表示“请求成功但延迟较高”
-- - 可用率/成功数统计不应把 degraded 记为失败，否则会出现 0/x 成功、0% 可用
-- =============================================================================

CREATE OR REPLACE VIEW public.availability_stats AS
SELECT
    config_id,
    '7d'::text AS period,
    COUNT(*) AS total_checks,
    COUNT(*) FILTER (WHERE status IN ('operational', 'degraded')) AS operational_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status IN ('operational', 'degraded')) / NULLIF(COUNT(*), 0),
        2
    ) AS availability_pct
FROM public.check_history
WHERE checked_at > NOW() - INTERVAL '7 days'
GROUP BY config_id

UNION ALL

SELECT
    config_id,
    '15d'::text AS period,
    COUNT(*) AS total_checks,
    COUNT(*) FILTER (WHERE status IN ('operational', 'degraded')) AS operational_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status IN ('operational', 'degraded')) / NULLIF(COUNT(*), 0),
        2
    ) AS availability_pct
FROM public.check_history
WHERE checked_at > NOW() - INTERVAL '15 days'
GROUP BY config_id

UNION ALL

SELECT
    config_id,
    '30d'::text AS period,
    COUNT(*) AS total_checks,
    COUNT(*) FILTER (WHERE status IN ('operational', 'degraded')) AS operational_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status IN ('operational', 'degraded')) / NULLIF(COUNT(*), 0),
        2
    ) AS availability_pct
FROM public.check_history
WHERE checked_at > NOW() - INTERVAL '30 days'
GROUP BY config_id;

COMMENT ON VIEW public.availability_stats IS '可用性统计视图（7天/15天/30天），degraded 视为可用';
