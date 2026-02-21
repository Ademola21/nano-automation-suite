const axios = require('axios');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { spawn } = require('child_process');
const path = require('path');

const sessionToken = process.argv[2];
const nanoAddress = process.argv[3];
const proxy = process.argv[4] || null;
const proxySeed = process.argv[5] || null;
const masterAddress = process.argv[6] || null;

if (!sessionToken || !nanoAddress) {
    console.log('Usage: node withdraw_nano.js <session_token> <nano_address> [proxy] [proxy_seed] [master_address]');
    process.exit(1);
}

const WS_URL = `wss://api.thenanobutton.com/ws?token=${sessionToken}`;
const API_WITHDRAW = 'https://api.thenanobutton.com/api/withdraw';
const TURNSTILE_SERVER = 'http://127.0.0.1:3000/cf-clearance-scraper';

async function getBalance() {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            return await new Promise((resolve, reject) => {
                console.log(`[INFO] Connecting to WebSocket (Attempt ${attempts}/${maxAttempts})...`);
                const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
                const ws = new WebSocket(WS_URL, { agent });

                const timeout = setTimeout(() => {
                    ws.terminate();
                    reject(new Error('WebSocket connection timed out'));
                }, 30000);

                ws.on('open', () => console.log('[WS] Connected. Waiting for balance...'));

                ws.on('message', (data) => {
                    const msg = data.toString();
                    try {
                        const json = JSON.parse(msg);
                        let balance = undefined;
                        if (json.balance !== undefined) balance = json.balance;
                        else if (json.session?.currentNano !== undefined) balance = json.session.currentNano;
                        else if (json.currentNano !== undefined) balance = json.currentNano;

                        if (balance !== undefined) {
                            clearTimeout(timeout);
                            ws.close();
                            resolve(balance);
                        }
                    } catch (e) { }
                });

                ws.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
        } catch (e) {
            console.error(`[WARN] getBalance failed: ${e.message}`);
            if (attempts < maxAttempts) {
                console.log('[INFO] Retrying WebSocket in 3s...');
                await new Promise(r => setTimeout(r, 3000));
            } else {
                throw e;
            }
        }
    }
}

async function solveTurnstile() {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        console.log(`[INFO] Requesting Turnstile token (Attempt ${attempts}/${maxAttempts})...`);
        try {
            let proxyObj = undefined;
            if (proxy) {
                try {
                    const pUrl = new URL(proxy);
                    proxyObj = {
                        host: pUrl.hostname,
                        port: parseInt(pUrl.port),
                        username: pUrl.username,
                        password: pUrl.password
                    };
                } catch (e) { }
            }

            // Using turnstile-max with the new 60s timeout for better token validity
            const res = await axios.post(TURNSTILE_SERVER, {
                mode: 'turnstile-max',
                url: 'https://thenanobutton.com/',
                proxy: proxyObj
            }, { timeout: 70000 });

            if (res.data && res.data.token) return res.data.token;
            throw new Error(res.data.message || 'Solver returned empty response');
        } catch (e) {
            const status = e.response ? e.response.status : (e.code || 'TIMEOUT/NETWORK');
            console.error(`[ERROR] Solver failed [${status}]: ${e.message}`);
            if (attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 5000));
            } else {
                throw e;
            }
        }
    }
}

async function withdraw(amount, turnstileToken = null) {
    const payload = { token: sessionToken, address: nanoAddress, amount: amount };
    if (turnstileToken) payload.turnstileToken = turnstileToken;

    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            console.log(`[INFO] Sending withdrawal request (Attempt ${attempts}/${maxAttempts})...`);
            const res = await axios.post(API_WITHDRAW, payload, {
                headers: {
                    'Origin': 'https://thenanobutton.com',
                    'Referer': 'https://thenanobutton.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Content-Type': 'application/json'
                },
                httpsAgent: proxy ? new HttpsProxyAgent(proxy) : undefined,
                timeout: 45000
            });

            if (res.status === 200 || res.status === 204) {
                console.log('[SUCCESS] Withdrawal processed successfully!');
                return true;
            }
            return false;
        } catch (e) {
            const isHangup = e.message.includes('socket hang up') ||
                e.message.includes('ECONNRESET') ||
                e.message.includes('disconnected');

            if (isHangup && attempts < maxAttempts) {
                console.log(`[WARN] Network hangup: ${e.message}. Retrying in 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }

            if (e.response && e.response.data && (e.response.data.captchaRequired || e.response.data.message?.includes('captcha'))) {
                console.log('[ALERT] CAPTCHA required for withdrawal.');
                if (turnstileToken) {
                    console.error('[ERROR] CAPTCHA failed even after solving. IP likely flagged or context mismatch.');
                    return false;
                }
                const newToken = await solveTurnstile();
                return withdraw(amount, newToken);
            }
            console.error(`[ERROR] Withdrawal failed: ${e.message}`);
            return false;
        }
    }
}

async function main() {
    try {
        const balance = await getBalance();
        console.log(`[INFO] Final Balance: ${balance}`);
        if (balance <= 0) process.exit(0);

        const success = await withdraw(balance);
        if (success) {
            console.log('[FINISH] Withdrawal successful.');
            if (proxySeed && masterAddress) {
                console.log('[INFO] Spawning consolidator...');
                await new Promise(r => setTimeout(r, 5000));
                const proc = spawn('node', ['consolidator.js', proxySeed, masterAddress], { stdio: 'inherit' });
                proc.on('close', (code) => process.exit(code));
            } else {
                process.exit(0);
            }
        } else {
            process.exit(1);
        }
    } catch (e) {
        console.error(`[CRITICAL] Withdrawal Script Failure: ${e.message}`);
        process.exit(1);
    }
}

main();
