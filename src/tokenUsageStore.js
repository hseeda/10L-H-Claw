const fs = require('fs');
const path = require('path');

const tokenUsagePath = path.join(__dirname, '..', 'logs', 'token_usage.json');
const PERIOD_LIMITS = {
    day: 400,
    week: 120,
    month: 60,
};

function pad2(value) {
    return String(value).padStart(2, '0');
}

function toDateParts(dateInput = new Date()) {
    const date = new Date(dateInput);
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    return { date, year, month, day };
}

function getWeekKey(dateInput = new Date()) {
    const date = new Date(dateInput);
    const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = utcDate.getUTCDay() || 7;
    utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
    return `${utcDate.getUTCFullYear()}-W${pad2(weekNo)}`;
}

function getPeriodKeys(dateInput = new Date()) {
    const { year, month, day } = toDateParts(dateInput);
    return {
        day: `${year}-${month}-${day}`,
        week: getWeekKey(dateInput),
        month: `${year}-${month}`,
    };
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function emptyTotals() {
    return {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        calls: 0,
    };
}

function cloneTotals(totals = {}) {
    return {
        input_tokens: toNumber(totals.input_tokens),
        output_tokens: toNumber(totals.output_tokens),
        total_tokens: toNumber(totals.total_tokens),
        cached_tokens: toNumber(totals.cached_tokens),
        reasoning_tokens: toNumber(totals.reasoning_tokens),
        calls: toNumber(totals.calls),
    };
}

function addUsage(totals, usage) {
    totals.input_tokens += toNumber(usage.input_tokens);
    totals.output_tokens += toNumber(usage.output_tokens);
    totals.total_tokens += toNumber(usage.total_tokens);
    totals.cached_tokens += toNumber(usage.cached_tokens);
    totals.reasoning_tokens += toNumber(usage.reasoning_tokens);
    totals.calls += 1;
}

function addTotals(target, source) {
    target.input_tokens += toNumber(source.input_tokens);
    target.output_tokens += toNumber(source.output_tokens);
    target.total_tokens += toNumber(source.total_tokens);
    target.cached_tokens += toNumber(source.cached_tokens);
    target.reasoning_tokens += toNumber(source.reasoning_tokens);
    target.calls += toNumber(source.calls);
}

function normalizeUsage(usage = {}) {
    const input = toNumber(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount);
    const output = toNumber(usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount);
    const total = toNumber(usage.total_tokens ?? usage.totalTokenCount ?? input + output);
    const cached = toNumber(usage.cached_tokens ?? usage.cachedTokenCount);
    const reasoning = toNumber(usage.reasoning_tokens ?? usage.reasoningTokenCount);

    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: total,
        cached_tokens: cached,
        reasoning_tokens: reasoning,
    };
}

function defaultStore() {
    return {
        version: 2,
        updated_at: new Date(0).toISOString(),
        models: [],
    };
}

function createAggregateBucket() {
    return {
        totals: emptyTotals(),
        platforms: {},
    };
}

function ensurePlatformBucket(bucket, platform) {
    const key = String(platform || 'unknown').trim().toLowerCase() || 'unknown';
    if (!bucket.platforms[key]) {
        bucket.platforms[key] = emptyTotals();
    }
    return bucket.platforms[key];
}

function ensureModelRecord(store, provider, model) {
    const providerKey = String(provider || '').trim().toLowerCase();
    const modelKey = String(model || '').trim();
    let record = store.models.find((item) => item.provider === providerKey && item.model === modelKey);
    if (!record) {
        record = {
            provider: providerKey,
            model: modelKey,
            all_time: createAggregateBucket(),
            periods: {
                day: {},
                week: {},
                month: {},
            },
        };
        store.models.push(record);
    }
    return record;
}

function ensurePeriodBucket(record, periodType, periodKey) {
    if (!record.periods[periodType][periodKey]) {
        record.periods[periodType][periodKey] = createAggregateBucket();
    }
    return record.periods[periodType][periodKey];
}

function addUsageToBucket(bucket, usage, platform) {
    addUsage(bucket.totals, usage);
    addUsage(ensurePlatformBucket(bucket, platform), usage);
}

function migrateLegacyStore(rawStore) {
    const migrated = defaultStore();
    const records = Array.isArray(rawStore && rawStore.records) ? rawStore.records : [];
    records.forEach((entry) => {
        const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();
        const periods = entry.periods || getPeriodKeys(timestamp);
        const usage = normalizeUsage(entry.usage);
        const provider = String(entry.provider || '').trim().toLowerCase();
        const model = String(entry.model || '').trim();
        const platform = String(entry.platform || '').trim().toLowerCase();
        if (!model) return;

        const record = ensureModelRecord(migrated, provider, model);
        addUsageToBucket(record.all_time, usage, platform);
        addUsageToBucket(ensurePeriodBucket(record, 'day', periods.day || getPeriodKeys(timestamp).day), usage, platform);
        addUsageToBucket(ensurePeriodBucket(record, 'week', periods.week || getPeriodKeys(timestamp).week), usage, platform);
        addUsageToBucket(ensurePeriodBucket(record, 'month', periods.month || getPeriodKeys(timestamp).month), usage, platform);
    });
    migrated.updated_at = typeof rawStore?.updated_at === 'string' ? rawStore.updated_at : new Date().toISOString();
    return migrated;
}

function ensureStoreShape(store) {
    if (!store || typeof store !== 'object') {
        return defaultStore();
    }

    if (store.version === 2 && Array.isArray(store.models)) {
        return {
            version: 2,
            updated_at: typeof store.updated_at === 'string' ? store.updated_at : new Date(0).toISOString(),
            models: store.models.map((record) => ({
                provider: String(record.provider || '').trim().toLowerCase(),
                model: String(record.model || '').trim(),
                all_time: {
                    totals: cloneTotals(record.all_time?.totals),
                    platforms: Object.fromEntries(Object.entries(record.all_time?.platforms || {}).map(([platform, totals]) => [platform, cloneTotals(totals)])),
                },
                periods: {
                    day: Object.fromEntries(Object.entries(record.periods?.day || {}).map(([key, bucket]) => [key, {
                        totals: cloneTotals(bucket.totals),
                        platforms: Object.fromEntries(Object.entries(bucket.platforms || {}).map(([platform, totals]) => [platform, cloneTotals(totals)])),
                    }])),
                    week: Object.fromEntries(Object.entries(record.periods?.week || {}).map(([key, bucket]) => [key, {
                        totals: cloneTotals(bucket.totals),
                        platforms: Object.fromEntries(Object.entries(bucket.platforms || {}).map(([platform, totals]) => [platform, cloneTotals(totals)])),
                    }])),
                    month: Object.fromEntries(Object.entries(record.periods?.month || {}).map(([key, bucket]) => [key, {
                        totals: cloneTotals(bucket.totals),
                        platforms: Object.fromEntries(Object.entries(bucket.platforms || {}).map(([platform, totals]) => [platform, cloneTotals(totals)])),
                    }])),
                },
            })),
        };
    }

    return migrateLegacyStore(store);
}

function prunePeriodBuckets(periodMap, limit) {
    const entries = Object.entries(periodMap || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (entries.length <= limit) {
        return Object.fromEntries(entries);
    }
    return Object.fromEntries(entries.slice(entries.length - limit));
}

function compactTokenUsageStore(store) {
    const safeStore = ensureStoreShape(store);
    safeStore.models = safeStore.models.map((record) => ({
        ...record,
        periods: {
            day: prunePeriodBuckets(record.periods?.day, PERIOD_LIMITS.day),
            week: prunePeriodBuckets(record.periods?.week, PERIOD_LIMITS.week),
            month: prunePeriodBuckets(record.periods?.month, PERIOD_LIMITS.month),
        },
    }));
    return safeStore;
}

function loadTokenUsageStore() {
    try {
        if (!fs.existsSync(tokenUsagePath)) {
            return defaultStore();
        }
        const raw = fs.readFileSync(tokenUsagePath, 'utf8');
        return compactTokenUsageStore(JSON.parse(raw));
    } catch (error) {
        return defaultStore();
    }
}

function saveTokenUsageStore(store) {
    const safeStore = compactTokenUsageStore(store);
    fs.mkdirSync(path.dirname(tokenUsagePath), { recursive: true });
    fs.writeFileSync(tokenUsagePath, JSON.stringify(safeStore, null, 2), 'utf8');
}

function clearTokenUsageHistory() {
    const store = defaultStore();
    store.updated_at = new Date().toISOString();
    saveTokenUsageStore(store);
    return store;
}

function recordTokenUsage(entry = {}) {
    const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();
    const periods = getPeriodKeys(timestamp);
    const usage = normalizeUsage(entry.usage);
    const provider = String(entry.provider || '').trim().toLowerCase();
    const model = String(entry.model || '').trim();
    const platform = String(entry.platform || '').trim().toLowerCase();
    const store = loadTokenUsageStore();

    if (!model) return null;

    const record = ensureModelRecord(store, provider, model);
    addUsageToBucket(record.all_time, usage, platform);
    addUsageToBucket(ensurePeriodBucket(record, 'day', periods.day), usage, platform);
    addUsageToBucket(ensurePeriodBucket(record, 'week', periods.week), usage, platform);
    addUsageToBucket(ensurePeriodBucket(record, 'month', periods.month), usage, platform);
    store.updated_at = new Date().toISOString();
    saveTokenUsageStore(store);
    return record;
}

function getSourceBuckets(store, period) {
    const rows = [];
    store.models.forEach((record) => {
        if (period === 'all') {
            rows.push({
                period: 'all',
                provider: record.provider,
                model: record.model,
                bucket: record.all_time,
            });
            return;
        }

        Object.entries(record.periods?.[period] || {}).forEach(([periodKey, bucket]) => {
            rows.push({
                period: periodKey,
                provider: record.provider,
                model: record.model,
                bucket,
            });
        });
    });
    return rows;
}

function getRecentDayRows(store, daysBack) {
    const rows = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - Math.max(0, daysBack - 1));

    store.models.forEach((record) => {
        Object.entries(record.periods?.day || {}).forEach(([periodKey, bucket]) => {
            const bucketDate = new Date(`${periodKey}T00:00:00`);
            if (Number.isNaN(bucketDate.getTime())) return;
            if (bucketDate < cutoff || bucketDate > today) return;
            rows.push({
                period: periodKey,
                provider: record.provider,
                model: record.model,
                bucket,
            });
        });
    });

    return rows;
}

function getTokenUsageSummary(options = {}) {
    const period = ['day', 'week', 'month', 'all'].includes(options.period) ? options.period : 'all';
    const groupBy = ['model', 'provider', 'platform', 'period'].includes(options.groupBy) ? options.groupBy : 'model';
    const tokenType = ['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens'].includes(options.tokenType)
        ? options.tokenType
        : null;
    const splitPeriods = options.splitPeriods === true || options.splitPeriods === '1' || options.splitPeriods === 1;
    const modelFilter = String(options.model || '').trim().toLowerCase();
    const providerFilter = String(options.provider || '').trim().toLowerCase();
    const platformFilter = String(options.platform || '').trim().toLowerCase();
    const store = loadTokenUsageStore();

    const sourceRows = period === 'day'
        ? getRecentDayRows(store, 1)
        : period === 'week'
            ? getRecentDayRows(store, 7)
            : period === 'month'
                ? getRecentDayRows(store, 30)
                : getSourceBuckets(store, period);
    const explodedRows = [];

    sourceRows.forEach((row) => {
        if (modelFilter && String(row.model || '').trim().toLowerCase() !== modelFilter) return;
        if (providerFilter && String(row.provider || '').trim().toLowerCase() !== providerFilter) return;

        if (platformFilter) {
            const platformTotals = row.bucket.platforms?.[platformFilter];
            if (!platformTotals) return;
            explodedRows.push({
                period: row.period,
                provider: row.provider,
                model: row.model,
                platform: platformFilter,
                totals: cloneTotals(platformTotals),
            });
            return;
        }

        if (groupBy === 'platform') {
            Object.entries(row.bucket.platforms || {}).forEach(([platform, totals]) => {
                explodedRows.push({
                    period: row.period,
                    provider: row.provider,
                    model: row.model,
                    platform,
                    totals: cloneTotals(totals),
                });
            });
            return;
        }

        explodedRows.push({
            period: row.period,
            provider: row.provider,
            model: row.model,
            platform: 'all',
            totals: cloneTotals(row.bucket.totals),
        });
    });

    const buckets = {};
    explodedRows.forEach((row) => {
        const rowGroupKey = groupBy === 'period'
            ? row.period
            : (groupBy === 'provider' ? row.provider : groupBy === 'platform' ? row.platform : row.model);
        const bucketKey = groupBy === 'period'
            ? row.period
            : splitPeriods && period !== 'all'
                ? `${rowGroupKey}__${row.period}`
                : rowGroupKey;
        if (!buckets[bucketKey]) {
            buckets[bucketKey] = {
                period: row.period,
                model: row.model,
                provider: row.provider,
                platform: row.platform,
                totals: emptyTotals(),
            };
        }
        addTotals(buckets[bucketKey].totals, row.totals);
    });

    const entries = Object.values(buckets).sort((a, b) => {
        if (a.period !== b.period) return String(a.period).localeCompare(String(b.period));
        if (a.model !== b.model) return String(a.model).localeCompare(String(b.model));
        if (a.provider !== b.provider) return String(a.provider).localeCompare(String(b.provider));
        return String(a.platform).localeCompare(String(b.platform));
    }).map((entry) => ({
        ...entry,
        selected_token_type: tokenType,
        selected_token_total: tokenType ? toNumber(entry.totals[tokenType]) : null,
    }));

    const totals = emptyTotals();
    entries.forEach((entry) => {
        addTotals(totals, entry.totals);
    });

    return {
        updated_at: store.updated_at,
        period,
        group_by: groupBy,
        filters: {
            model: modelFilter || null,
            provider: providerFilter || null,
            platform: platformFilter || null,
            token_type: tokenType,
        },
        totals,
        selected_token_total: tokenType ? toNumber(totals[tokenType]) : null,
        entries,
    };
}

module.exports = {
    tokenUsagePath,
    loadTokenUsageStore,
    saveTokenUsageStore,
    clearTokenUsageHistory,
    recordTokenUsage,
    getTokenUsageSummary,
    compactTokenUsageStore,
};
