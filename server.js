const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = 'data.json';

// Middleware setup
app.use(cors());
app.use(bodyParser.json());

// Serve static files
app.use(express.static(path.join(__dirname)));

// Get client's real IP address
function getClientIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.headers['x-real-ip'] || 
           req.socket.remoteAddress || 
           req.connection.remoteAddress || 
           (req.socket && req.socket.remoteAddress) || 
           'IP_UNKNOWN';
}

// Get IP geolocation from free API (with fallback)
function getGeolocation(ip) {
    return new Promise((resolve) => {
        if (ip === 'IP_UNKNOWN' || ip === '::1' || ip === '127.0.0.1') {
            resolve({ city: 'Localhost', country: 'Local', timezone: 'Local' });
            return;
        }
        
        // Try ipapi.co first
        https.get(`https://ipapi.co/${ip}/json/`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error || json.reason) {
                        throw new Error(json.reason || 'API error');
                    }
                    resolve({
                        city: json.city || 'Unknown',
                        country: json.country_name || 'Unknown',
                        countryCode: json.country_code || 'Unknown',
                        timezone: json.timezone || 'Unknown',
                        region: json.region || 'Unknown',
                        org: json.org || 'Unknown',
                        latitude: json.latitude || null,
                        longitude: json.longitude || null,
                        source: 'ipapi.co (server)'
                    });
                } catch (e) {
                    getGeolocationFallback(ip).then(resolve);
                }
            });
        }).on('error', () => {
            getGeolocationFallback(ip).then(resolve);
        });
    });
}

// Fallback geolocation API
function getGeolocationFallback(ip) {
    return new Promise((resolve) => {
        https.get(`https://freeipapi.com/api/json/${ip}`, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({
                        city: json.cityName || 'Unknown',
                        country: json.countryName || 'Unknown',
                        countryCode: json.countryCode || 'Unknown',
                        timezone: json.timeZone || 'Unknown',
                        region: json.regionName || 'Unknown',
                        org: 'Unknown',
                        latitude: json.latitude || null,
                        longitude: json.longitude || null,
                        source: 'freeipapi.com (server)'
                    });
                } catch (e) {
                    resolve({ city: 'Unknown', country: 'Unknown', timezone: 'Unknown', source: 'none' });
                }
            });
        }).on('error', () => {
            resolve({ city: 'Unknown', country: 'Unknown', timezone: 'Unknown', source: 'none' });
        });
    });
}

// Helper to read all logs from DB file (newest first)
function readLogs() {
    if (!fs.existsSync(DB_FILE)) {
        return [];
    }
    const content = fs.readFileSync(DB_FILE, 'utf8');
    return content.trim().split('\n').filter(line => line.trim()).map(line => {
        try {
            return JSON.parse(line);
        } catch (e) {
            return null;
        }
    }).filter(Boolean).reverse();
}

// --- Data Logging Endpoint ---
app.post('/api/log_data', async (req, res) => {
    const trackingData = req.body;

    if (!trackingData || !trackingData.trigger) {
        return res.status(400).json({ message: "Missing tracking data." });
    }

    // Add server-side IP detection
    trackingData.serverIP = getClientIP(req);
    trackingData.userAgent = req.headers['user-agent'];
    trackingData.serverTimestamp = new Date().toISOString();
    
    // Determine loopback / local testing IP
    const isLoopback = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(trackingData.serverIP);
    
    if (isLoopback && trackingData.clientGeolocation) {
        // Use client-reported public IP and geolocation for local connections
        trackingData.geolocation = {
            ...trackingData.clientGeolocation,
            source: trackingData.clientGeolocation.source + ' (client-reported)'
        };
        trackingData.publicIP = trackingData.clientGeolocation.publicIP;
    } else {
        // Use server-side geolocation lookup
        trackingData.geolocation = await getGeolocation(trackingData.serverIP);
    }

    const logEntry = JSON.stringify(trackingData) + '\n';

    fs.appendFile(DB_FILE, logEntry, (err) => {
        if (err) {
            console.error("Error writing to log file:", err);
            return res.status(500).json({ message: "Server error while writing logs." });
        }
        console.log(`[LOGGED] ${trackingData.trigger} from: ${trackingData.geolocation.city}, ${trackingData.geolocation.country}`);
        res.json({ message: "Data successfully recorded!" });
    });
});

// --- API Stats Endpoint (Aggregations for dashboard) ---
app.get('/api/stats', (req, res) => {
    const logs = readLogs();
    
    const stats = {
        totalVisits: logs.length,
        uniqueUsers: new Set(logs.map(l => l.userId)).size,
        pageLoads: logs.filter(l => l.trigger === 'Page Load').length,
        imageClicks: logs.filter(l => l.trigger === 'Image Click').length,
        elementClicks: logs.filter(l => l.trigger === 'Element Click').length,
        
        // Scroll depth milestones
        scrollDepth: {
            25: logs.filter(l => l.trigger === 'Scroll Depth Crossing' && l.eventMetadata?.milestone === 25).length,
            50: logs.filter(l => l.trigger === 'Scroll Depth Crossing' && l.eventMetadata?.milestone === 50).length,
            75: logs.filter(l => l.trigger === 'Scroll Depth Crossing' && l.eventMetadata?.milestone === 75).length,
            100: logs.filter(l => l.trigger === 'Scroll Depth Crossing' && l.eventMetadata?.milestone === 100).length,
        },
        
        avgTimeOnPage: 0,
        visitsOverTime: {},
        clicksByElement: {},
        topUsers: []
    };

    // Calculate time spent
    const exitLogs = logs.filter(l => l.timeOnPage !== undefined && l.timeOnPage > 0);
    if (exitLogs.length > 0) {
        const totalTime = exitLogs.reduce((sum, l) => sum + (l.timeOnPage || 0), 0);
        stats.avgTimeOnPage = Math.round(totalTime / exitLogs.length);
    }

    // Visits over time (group by YYYY-MM-DD)
    // Create sorted list of dates in UTC format to avoid timezone shifts
    logs.forEach(log => {
        if (!log.timestamp) return;
        const dateStr = log.timestamp.split('T')[0];
        stats.visitsOverTime[dateStr] = (stats.visitsOverTime[dateStr] || 0) + 1;
    });

    // Element clicks mapping
    logs.forEach(log => {
        if (log.trigger === 'Element Click' || log.trigger === 'Image Click') {
            const el = log.eventMetadata?.element || 'unknown';
            const idStr = log.eventMetadata?.id ? `#${log.eventMetadata.id}` : '';
            const key = `${el}${idStr}`;
            stats.clicksByElement[key] = (stats.clicksByElement[key] || 0) + 1;
        }
    });

    // Top active users
    const userEventCounts = {};
    logs.forEach(log => {
        userEventCounts[log.userId] = (userEventCounts[log.userId] || 0) + 1;
    });
    
    stats.topUsers = Object.entries(userEventCounts)
        .map(([userId, count]) => {
            const userLogs = logs.filter(l => l.userId === userId);
            const lastLog = userLogs[0];
            return {
                userId,
                eventCount: count,
                lastSeen: lastLog?.timestamp || 'Unknown',
                location: lastLog?.geolocation?.city ? `${lastLog.geolocation.city}, ${lastLog.geolocation.country}` : 'Unknown',
                ip: lastLog?.publicIP || lastLog?.serverIP || 'Unknown'
            };
        })
        .sort((a, b) => b.eventCount - a.eventCount)
        .slice(0, 5);

    res.json(stats);
});

// --- API Recent Events Endpoint ---
app.get('/api/recent', (req, res) => {
    const logs = readLogs();
    res.json(logs.slice(0, 50));
});

// --- API Sessions Endpoint ---
app.get('/api/sessions', (req, res) => {
    const logs = readLogs();
    const sessions = {};
    
    logs.forEach(log => {
        const sid = log.sessionId;
        if (!sid) return;
        
        if (!sessions[sid]) {
            sessions[sid] = {
                sessionId: sid,
                userId: log.userId,
                userType: log.userType || 'unknown',
                startTime: log.timestamp,
                endTime: log.timestamp,
                eventsCount: 0,
                location: log.geolocation?.city ? `${log.geolocation.city}, ${log.geolocation.country}` : 'Unknown',
                device: log.deviceInfo?.platform || 'Unknown',
                browser: log.deviceInfo?.userAgent ? parseBrowser(log.deviceInfo.userAgent) : 'Unknown',
                ip: log.publicIP || log.serverIP || 'Unknown',
                timeSpent: 0,
                maxScroll: 0
            };
        }
        
        sessions[sid].eventsCount++;
        if (new Date(log.timestamp) < new Date(sessions[sid].startTime)) {
            sessions[sid].startTime = log.timestamp;
        }
        if (new Date(log.timestamp) > new Date(sessions[sid].endTime)) {
            sessions[sid].endTime = log.timestamp;
        }
        if (log.timeOnPage && log.timeOnPage > sessions[sid].timeSpent) {
            sessions[sid].timeSpent = log.timeOnPage;
        }
        if (log.maxScroll && log.maxScroll > sessions[sid].maxScroll) {
            sessions[sid].maxScroll = log.maxScroll;
        }
    });

    const sessionList = Object.values(sessions).sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json(sessionList.slice(0, 30));
});

function parseBrowser(ua) {
    if (ua.includes('Edg/')) return 'Edge';
    if (ua.includes('Chrome/')) return 'Chrome';
    if (ua.includes('Safari/')) return 'Safari';
    if (ua.includes('Firefox/')) return 'Firefox';
    return 'Other';
}

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Analytics Server listening on http://localhost:${PORT}`);
    console.log(`📊 SaaS Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`🌐 Live Website: http://localhost:${PORT}/index.html`);
});
