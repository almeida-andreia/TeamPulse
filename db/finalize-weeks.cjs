// Explicit maintenance operation for the existing weekly release lifecycle.
// Never enroll past employees, reconstruct membership, edit responses, or relax
// privacy thresholds. Missing/incomplete cohorts still fail closed in reporting.
async function finalizeWeeks(pool) {
    const client = await pool.connect(); let begun = false, discard;
    try {
        await client.query("BEGIN"); begun = true;
        const result = await client.query(`/* maintenance:finalize-closed-weeks */
            UPDATE wellbeing.team_weeks SET finalized_at=CURRENT_TIMESTAMP
            WHERE finalized_at IS NULL
                AND week_start < date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date`);
        // Existing cohort locks/triggers serialize this with enrollment and
        // submission. The database also prevents reopening a finalized cohort.
        await client.query("COMMIT"); begun = false;
        return { finalized: result.rowCount };
    } catch (error) {
        if (begun) { try { await client.query("ROLLBACK"); } catch (failure) { discard = failure; } }
        throw error;
    } finally { client.release(discard); }
}
if (require.main === module) {
    let pool;
    (async () => {
        try { pool = require("../server/db").pool; console.log(JSON.stringify(await finalizeWeeks(pool))); }
        catch { console.error("Weekly finalization failed. Check database configuration and maintenance permissions; no partial changes were retained."); process.exitCode = 1; }
        finally { if (pool) await pool.end(); }
    })();
}
module.exports = { finalizeWeeks };
