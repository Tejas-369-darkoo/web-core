// --- CONFIGURATION ---
const BACKEND_ENDPOINT = '/api/log_data';

// Generate or get unique user ID
function getUserId() {
    let userId = localStorage.getItem('traker_user_id');
    if (!userId) {
        userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('traker_user_id', userId);
    }
    return userId;
}

// Generate or get session ID (changes on every visit)
function getSessionId() {
    let sessionId = sessionStorage.getItem('traker_session_id');
    if (!sessionId) {
        sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        sessionStorage.setItem('traker_session_id', sessionId);
    }
    return sessionId;
}

// Detect if user is new or returning
function getUserType() {
    let userType = localStorage.getItem('traker_user_type');
    if (!userType) {
        localStorage.setItem('traker_user_type', 'returning');
        return 'new';
    }
    return 'returning';
}

// Generate browser fingerprint (unique device ID)
async function getFingerprint() {
    const components = [];
    
    // Screen info
    components.push(`screen:${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`);
    
    // Browser info
    components.push(`ua:${navigator.userAgent}`);
    components.push(`lang:${navigator.language}`);
    components.push(`platform:${navigator.platform}`);
    
    // Timezone
    components.push(`tz:${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    
    // Hardware
    components.push(`cores:${navigator.hardwareConcurrency}`);
    components.push(`memory:${navigator.deviceMemory || 'unknown'}`);
    
    // Canvas fingerprint
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillText('fingerprint', 2, 2);
        components.push(`canvas:${canvas.toDataURL().substr(-50)}`);
    } catch (e) {
        components.push('canvas:na');
    }
    
    // WebGL fingerprint
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
                components.push(`webgl:${gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)}`);
            }
        }
    } catch (e) {
        components.push('webgl:na');
    }
    
    // Hash the components
    let hash = 0;
    const str = components.join('|');
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'fp_' + Math.abs(hash).toString(36);
}

/** 1. Passive Client Info Collection (no permissions needed) */
function getClientDeviceInfo() {
    return {
        // Browser & OS
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
        
        // Time & Location (passive)
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timezoneOffset: new Date().getTimezoneOffset(),
        
        // Screen & Display
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        screenColorDepth: window.screen.colorDepth,
        screenPixelDepth: window.screen.pixelDepth,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        
        // Browser Features
        cookiesEnabled: navigator.cookieEnabled,
        doNotTrack: navigator.doNotTrack,
        online: navigator.onLine,
        
        // Hardware
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory || 'unknown',
        
        // Page Info
        referrer: document.referrer,
        url: window.location.href,
        title: document.title
    };
}

/** 2. WebRTC for IP Address Approximation */
function getIPAddress() {
    return new Promise((resolve) => {
        const pc = new RTCPeerConnection();
        let ipFound = false;

        pc.createOffer().then(offer => pc.setLocalDescription(offer));

        pc.onicecandidate = event => {
            if (event.candidate && !ipFound) {
                const candidate = event.candidate;
                const ipMatch = candidate.candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
                if (ipMatch) {
                    resolve(ipMatch[0]);
                    pc.close();
                    ipFound = true;
                }
            }
        };

        setTimeout(() => {
            if (!ipFound) {
                resolve("IP_UNKNOWN");
                pc.close();
            }
        }, 1500);
    });
}

/** 3. Client-Side Geolocation via Public APIs */
async function getClientGeolocation() {
    try {
        const response = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
            const data = await response.json();
            if (data.ip) {
                return {
                    publicIP: data.ip,
                    city: data.city || 'Unknown',
                    region: data.region || 'Unknown',
                    country: data.country_name || 'Unknown',
                    countryCode: data.country_code || 'Unknown',
                    timezone: data.timezone || 'Unknown',
                    org: data.org || 'Unknown',
                    latitude: data.latitude || null,
                    longitude: data.longitude || null,
                    source: 'ipapi.co'
                };
            }
        }
    } catch (e) {
        console.warn('ipapi.co failed, trying fallback...', e.message);
    }

    try {
        const response = await fetch('https://freeipapi.com/api/json', { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
            const data = await response.json();
            if (data.ipAddress) {
                return {
                    publicIP: data.ipAddress,
                    city: data.cityName || 'Unknown',
                    region: data.regionName || 'Unknown',
                    country: data.countryName || 'Unknown',
                    countryCode: data.countryCode || 'Unknown',
                    timezone: data.timeZone || 'Unknown',
                    org: 'Unknown',
                    latitude: data.latitude || null,
                    longitude: data.longitude || null,
                    source: 'freeipapi.com'
                };
            }
        }
    } catch (e) {
        console.warn('freeipapi.com also failed:', e.message);
    }

    return null;
}

// Variables for scroll and time tracking
let maxScrollPercentage = 0;
const startTime = Date.now();
const scrollMilestones = { '25': false, '50': false, '75': false, '100': false };
let fingerprintCache = null;
let clientGeolocationCache = null;

// Build payload structure
async function buildPayload(triggerEvent, eventMetadata = {}) {
    if (!fingerprintCache) {
        fingerprintCache = await getFingerprint();
    }
    if (!clientGeolocationCache) {
        clientGeolocationCache = await getClientGeolocation();
    }

    const deviceInfo = getClientDeviceInfo();
    
    // Add local IP from WebRTC as fallback
    try {
        deviceInfo.ipAddress = await getIPAddress();
    } catch (e) {
        deviceInfo.ipAddress = "IP_UNKNOWN";
    }

    return {
        timestamp: new Date().toISOString(),
        trigger: triggerEvent,
        userId: getUserId(),
        sessionId: getSessionId(),
        userType: getUserType(),
        fingerprint: fingerprintCache,
        deviceInfo: deviceInfo,
        clientGeolocation: clientGeolocationCache,
        eventMetadata: eventMetadata,
        timeOnPage: Math.round((Date.now() - startTime) / 1000), // in seconds
        maxScroll: maxScrollPercentage
    };
}

/** 4. Main Data Submission Function */
async function collectAndSendData(triggerEvent, eventMetadata = {}) {
    try {
        const trackingData = await buildPayload(triggerEvent, eventMetadata);
        console.log(`[TRACKER] Sending ${triggerEvent}:`, trackingData);
        
        fetch(BACKEND_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(trackingData),
            keepalive: true // crucial for exit tracking
        })
        .catch(err => console.error('Error sending tracking data:', err));
    } catch (e) {
        console.error('Failed to collect tracking data:', e);
    }
}

// --- EVENT HANDLERS ---

// 1. Click Tracking (Image + Elements)
document.addEventListener('click', (e) => {
    let node = e.target;
    let isTrackedImage = false;
    
    while (node && node !== document.body) {
        if (node.id === 'trackedImage' || node.id === 'imageContainer') {
            isTrackedImage = true;
            break;
        }
        node = node.parentNode;
    }

    const clickDetails = {
        element: e.target.tagName.toLowerCase(),
        id: e.target.id || null,
        classes: e.target.className || null,
        text: e.target.innerText ? e.target.innerText.substring(0, 30).trim() : null
    };

    if (isTrackedImage) {
        collectAndSendData("Image Click", clickDetails);
    } else {
        collectAndSendData("Element Click", clickDetails);
    }
});

// 2. Scroll Depth Tracking
function trackScrollDepth() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    if (scrollHeight <= 0) return;

    const scrollPercentage = Math.min(100, Math.round((scrollTop / scrollHeight) * 100));
    
    if (scrollPercentage > maxScrollPercentage) {
        maxScrollPercentage = scrollPercentage;
    }

    // Trigger on milestone crossings (25%, 50%, 75%, 100%)
    for (let milestone in scrollMilestones) {
        if (scrollPercentage >= parseInt(milestone) && !scrollMilestones[milestone]) {
            scrollMilestones[milestone] = true;
            collectAndSendData("Scroll Depth Crossing", { milestone: parseInt(milestone) });
        }
    }
}

window.addEventListener('scroll', trackScrollDepth);

// 3. Page Load Event
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        collectAndSendData("Page Load");
    }, 500);
});

// 4. Page Exit Event (capturing scroll depth and time spent)
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        buildPayload("Page Exit").then(payload => {
            navigator.sendBeacon(BACKEND_ENDPOINT, JSON.stringify(payload));
        });
    }
});
