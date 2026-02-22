const nano = require('nanocurrency');
const axios = require('axios');

const NODES = [
    'https://rainstorm.city/api',
    'https://node.somenano.com/proxy',
    'https://nanoslo.0x.no/proxy',
    'https://uk1.public.xnopay.com/proxy'
];

async function broadcast(action, data, customTimeout = 10000) {
    let lastError = null;
    for (const url of NODES) {
        try {
            const res = await axios.post(url, { action, ...data }, { timeout: customTimeout });
            if (res.data && !res.data.error) {
                if (action !== 'pending' && action !== 'account_info') {
                    console.log(`[CONSOLIDATOR] [OK] ${action} successful via ${url}`);
                }
                return res.data;
            }
            if (res.data && res.data.error) {
                console.log(`[CONSOLIDATOR] [DEBUG] ${url} error for ${action}: ${res.data.error}`);
            }
        } catch (e) {
            console.log(`[CONSOLIDATOR] [DEBUG] ${url} failed for ${action}: ${e.message}`);
            lastError = e.message;
        }
    }
    throw new Error(lastError || `All RPC nodes failed to process action: ${action}`);
}

async function getWork(hash) {
    console.log(`[CONSOLIDATOR] [REMOTE] Generating PoW for ${hash.slice(0, 8)}...`);
    // Try up to 3 times with increasing timeout
    const attempts = [30000, 45000, 60000];
    for (let i = 0; i < attempts.length; i++) {
        try {
            console.log(`[CONSOLIDATOR] [POW] Attempt ${i + 1}/${attempts.length} (timeout: ${attempts[i] / 1000}s)...`);
            const res = await broadcast('work_generate', { hash }, attempts[i]);
            if (res && res.work) {
                console.log(`[CONSOLIDATOR] [POW] Work generated on attempt ${i + 1}!`);
                return res.work;
            }
        } catch (e) {
            console.log(`[CONSOLIDATOR] [POW] Attempt ${i + 1} failed: ${e.message}`);
            if (i < attempts.length - 1) {
                console.log(`[CONSOLIDATOR] [POW] Retrying in 3s...`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }
    console.log(`[CONSOLIDATOR] [FATAL] Remote PoW generation failed after all retries.`);
    return null;
}

async function consolidate(seed, destination) {
    console.log(`[CONSOLIDATOR] Initiating transfer to ${destination}...`);

    const privateKey = nano.deriveSecretKey(seed, 0);
    const publicKey = nano.derivePublicKey(privateKey);
    const address = nano.deriveAddress(publicKey).replace('xrb_', 'nano_');

    try {
        // 1. Check for Pending blocks with Retry Interlock
        let pending = { blocks: {} };
        const maxPendingAttempts = 8;

        for (let attempt = 1; attempt <= maxPendingAttempts; attempt++) {
            console.log(`[CONSOLIDATOR] Checking for pending blocks for ${address} (Attempt ${attempt}/${maxPendingAttempts})...`);
            pending = await broadcast('pending', { account: address, count: "10", threshold: "1" });

            if (pending.blocks && Object.keys(pending.blocks).length > 0) {
                console.log(`[CONSOLIDATOR] Found ${Object.keys(pending.blocks).length} pending blocks!`);
                break;
            }

            if (attempt < maxPendingAttempts) {
                const waitTime = attempt <= 3 ? 10000 : 15000; // Wait longer on later attempts
                console.log(`[CONSOLIDATOR] No pending blocks yet. Waiting ${waitTime / 1000}s for on-chain confirmation...`);
                await new Promise(r => setTimeout(r, waitTime));
            }
        }

        if (pending.blocks && Object.keys(pending.blocks).length > 0) {

            for (const hash of Object.keys(pending.blocks)) {
                // Get account info for frontier
                let info = { balance: "0", frontier: "0000000000000000000000000000000000000000000000000000000000000000" };
                try {
                    const i = await broadcast('account_info', { account: address });
                    info = i;
                } catch (e) { /* Account might not be opened yet */ }

                const amount = pending.blocks[hash];
                const newBalance = (BigInt(info.balance) + BigInt(amount)).toString();

                // Get Work
                const workHash = info.frontier === "0000000000000000000000000000000000000000000000000000000000000000" ? publicKey : info.frontier;
                const work = await getWork(workHash);
                if (!work) {
                    console.error(`[CONSOLIDATOR] [FATAL] Could not receive pending block: Work generation failed on all nodes.`);
                    throw new Error("Work generation failed");
                }

                const receiveBlock = nano.createBlock(privateKey, {
                    work: work,
                    previous: info.frontier,
                    representative: address,
                    balance: newBalance,
                    link: hash
                });

                await broadcast('process', { json_block: "true", block: receiveBlock.block });
                console.log(`[CONSOLIDATOR] Received block ${hash.slice(0, 8)}...`);
                // Wait for confirmation
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // 2. Consolidate full balance to Master Wallet
        const info = await broadcast('account_info', { account: address });
        const balance = info.balance;

        if (BigInt(balance) <= 0n) {
            console.log('[CONSOLIDATOR] No balance found to send to master.');
            return;
        }

        console.log(`[CONSOLIDATOR] Consolidating ${balance} to master...`);
        const work = await getWork(info.frontier);
        if (!work) {
            console.error(`[CONSOLIDATOR] [FATAL] Consolidation failed: Work generation failed for send block.`);
            throw new Error("Work generation failed");
        }

        const sendBlock = nano.createBlock(privateKey, {
            work: work,
            previous: info.frontier,
            representative: address,
            balance: "0",
            link: destination
        });

        const result = await broadcast('process', { json_block: "true", block: sendBlock.block });
        console.log(`[CONSOLIDATOR] [SUCCESS] Consummated transfer to ${destination.slice(0, 16)}... Hash: ${result.hash}`);

    } catch (e) {
        console.error(`[CONSOLIDATOR] [ERROR] ${e.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    const seed = process.argv[2];
    const destination = process.argv[3];
    if (!seed || !destination) {
        console.log('Usage: node consolidator.js <seed> <destination>');
        process.exit(1);
    }
    consolidate(seed, destination);
}

module.exports = { consolidate };
