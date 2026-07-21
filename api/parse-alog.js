// api/parse-alog.js

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { alogContents, exclusionListText } = req.body;

        // Parse Custom Exclusion TRs
        const customExclusionSet = new Set();
        if (exclusionListText) {
            const matches = exclusionListText.match(/\b[A-Z0-9]{10}\b/gi);
            if (matches) {
                matches.forEach(tr => customExclusionSet.add(tr.toUpperCase().trim()));
            }
        }

        let importEventsList = [];

        // Parse each ALOG text payload
        alogContents.forEach(text => {
            const lines = text.split('\n');
            let activeImportMap = {};

            lines.forEach(line => {
                if (!line.trim() || line.startsWith('#')) return;

                const tokens = line.trim().split(/\s+/);
                if (tokens.length < 5) return;

                const trId = tokens[0];
                if (trId === 'ALL') return;

                const step = tokens[2];
                const rcCode = tokens[3];
                const timestampStr = tokens[4];
                const owner = tokens[5] || 'UNKNOWN';

                if (!/^\d{14}$/.test(timestampStr)) return;

                // Exclude buffer additions ('u'), exports ('e'), and skipped ('!')
                const lowerStep = step.toLowerCase();
                if (lowerStep === 'u' || lowerStep === 'e' || step === '!') return;

                const year = timestampStr.substring(0, 4);
                const month = timestampStr.substring(4, 6);
                const day = timestampStr.substring(6, 8);
                const hour = timestampStr.substring(8, 10);
                const min = timestampStr.substring(10, 12);
                const sec = timestampStr.substring(12, 14);
                const entryDate = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);

                if (step === 'L') {
                    const newImport = {
                        trId,
                        owner,
                        maxRc: rcCode,
                        startTime: entryDate.toISOString(),
                        endTime: entryDate.toISOString(),
                        waitTimeSec: 0
                    };
                    importEventsList.push(newImport);
                    activeImportMap[trId] = newImport;
                    return;
                }

                let targetImport = activeImportMap[trId];
                if (!targetImport) {
                    targetImport = {
                        trId,
                        owner,
                        maxRc: rcCode,
                        startTime: entryDate.toISOString(),
                        endTime: entryDate.toISOString(),
                        waitTimeSec: 0
                    };
                    importEventsList.push(targetImport);
                    activeImportMap[trId] = targetImport;
                }

                if (entryDate < new Date(targetImport.startTime)) targetImport.startTime = entryDate.toISOString();
                if (entryDate > new Date(targetImport.endTime)) targetImport.endTime = entryDate.toISOString();

                if (owner !== 'TMSADM' && owner !== 'DDIC' && owner !== 'UNKNOWN') {
                    targetImport.owner = owner;
                }

                if (parseInt(rcCode) > parseInt(targetImport.maxRc)) {
                    targetImport.maxRc = rcCode;
                }
            });
        });

        // Ensure start <= end time
        importEventsList.forEach(tr => {
            if (new Date(tr.endTime) < new Date(tr.startTime)) {
                tr.endTime = tr.startTime;
            }
        });

        // Sort chronologically
        importEventsList.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

        // Sequencing logic & wait time calculation
        let maxPreviousEndTime = null;
        for (let i = 0; i < importEventsList.length; i++) {
            const run = importEventsList[i];
            const startMs = new Date(run.startTime).getTime();
            const endMs = new Date(run.endTime).getTime();

            if (i === 0 || !maxPreviousEndTime) {
                run.waitTimeSec = 0;
                maxPreviousEndTime = endMs;
            } else {
                if (startMs >= maxPreviousEndTime) {
                    run.waitTimeSec = Math.floor((startMs - maxPreviousEndTime) / 1000);
                } else {
                    run.waitTimeSec = 0;
                }
                if (endMs > maxPreviousEndTime) {
                    maxPreviousEndTime = endMs;
                }
            }
        }

        // Apply custom exclusions
        const filteredList = importEventsList.filter(tr => !customExclusionSet.has(tr.trId.toUpperCase()));

        return res.status(200).json({
            success: true,
            totalExcluded: customExclusionSet.size,
            data: filteredList
        });

    } catch (err) {
        return res.status(500).json({ error: 'Failed to process logs', details: err.message });
    }
}
