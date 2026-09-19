/**
 * Smart Books — Push Notification Cloud Functions
 * ------------------------------------------------
 * Watches the Realtime Database for new sales, restock invoices and
 * inventory items, and sends a push notification (via Firebase Cloud
 * Messaging) to every device that has registered for that business.
 *
 * DEPLOY:
 *   1. npm install -g firebase-tools   (if you don't have it already)
 *   2. firebase login
 *   3. From the project root (the folder that contains this "functions"
 *      folder), run:  firebase init functions
 *        - choose "Use an existing project" → your Smart Books project
 *        - when it asks to overwrite files, say NO (keep these files)
 *   4. cd functions && npm install
 *   5. firebase deploy --only functions
 *
 * REQUIREMENTS:
 *   - Your Firebase project must be on the "Blaze" (pay-as-you-go) plan.
 *     Cloud Functions do not run on the free "Spark" plan. In practice,
 *     this workload is tiny and normally stays within the free monthly
 *     quota even on Blaze.
 *   - Realtime Database must be enabled (it already is, since the app
 *     uses it).
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.database();
const messaging = admin.messaging();
const ROOT = 'Retail';

/** Read this business's notification toggles (defaults to all-on). */
async function getSettings(bizId) {
    const snap = await db.ref(`${ROOT}/Businesses/${bizId}/Settings`).once('value');
    return snap.exists() ? snap.val() : {};
}

/** Read every registered device token for this business. */
async function getDeviceTokens(bizId) {
    const snap = await db.ref(`${ROOT}/Businesses/${bizId}/DeviceTokens`).once('value');
    if (!snap.exists()) return [];
    const val = snap.val();
    return Object.entries(val)
        .map(([key, v]) => ({ key, token: v && v.token }))
        .filter(t => !!t.token);
}

/** Remove tokens that FCM reports as no longer valid. */
async function pruneTokens(bizId, deadKeys) {
    if (!deadKeys.length) return;
    const updates = {};
    deadKeys.forEach(key => { updates[key] = null; });
    await db.ref(`${ROOT}/Businesses/${bizId}/DeviceTokens`).update(updates);
}

/**
 * Send a notification to every device registered for a business.
 * @param {string} bizId
 * @param {{title:string, body:string, tag?:string, url?:string, count?:number}} content
 */
async function sendToBusiness(bizId, content) {
    const devices = await getDeviceTokens(bizId);
    if (!devices.length) return;

    const message = {
        notification: { title: content.title, body: content.body },
        data: {
            tag: content.tag || '',
            url: content.url || './',
            count: String(content.count || 0)
        },
        tokens: devices.map(d => d.token),
        webpush: {
            fcmOptions: { link: content.url || './' },
            notification: { icon: content.icon || undefined }
        }
    };

    const res = await messaging.sendEachForMulticast(message);

    const deadKeys = [];
    res.responses.forEach((r, i) => {
        if (!r.success) {
            const code = r.error && r.error.code;
            if (code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token') {
                deadKeys.push(devices[i].key);
            }
        }
    });
    await pruneTokens(bizId, deadKeys);
}

/** Count of currently-unread-worthy items isn't tracked server-side;
 *  we just send 1 as a lightweight "something changed" badge hint.
 *  The client's own unread count (via setAppBadge in the app) takes
 *  over once the app has been opened at least once after the push. */
const BADGE_HINT = 1;

// ============================================================
// New sale
// ============================================================
exports.onSaleCreated = functions.database
    .ref(`/${ROOT}/Businesses/{bizId}/Sales/{saleId}`)
    .onCreate(async (snapshot, context) => {
        const { bizId } = context.params;
        const settings = await getSettings(bizId);
        if (settings.notifySales === false) return null;

        const sale = snapshot.val() || {};
        const qty = Array.isArray(sale.items) ? sale.items.reduce((a, l) => a + (l.qty || 0), 0) : 0;
        const soldBy = sale.soldBy ? ` · by ${sale.soldBy}` : '';

        return sendToBusiness(bizId, {
            title: `Sale ${sale.id || context.params.saleId}`,
            body: `${qty} item${qty === 1 ? '' : 's'} sold${soldBy}`,
            tag: 'sale',
            url: './',
            count: BADGE_HINT
        });
    });

// ============================================================
// New restock invoice
// ============================================================
exports.onRestockCreated = functions.database
    .ref(`/${ROOT}/Businesses/{bizId}/Restock_Invoices/{invoiceNo}`)
    .onCreate(async (snapshot, context) => {
        const { bizId, invoiceNo } = context.params;
        const settings = await getSettings(bizId);
        if (settings.notifyRestock === false) return null;

        const inv = snapshot.val() || {};
        const units = Array.isArray(inv.items) ? inv.items.reduce((a, l) => a + (l.qty || 0), 0) : 0;

        return sendToBusiness(bizId, {
            title: `Restock ${invoiceNo} received`,
            body: `${units} unit${units === 1 ? '' : 's'} from ${inv.supplier || 'supplier'}`,
            tag: 'restock',
            url: './',
            count: BADGE_HINT
        });
    });

// ============================================================
// New inventory item added
// ============================================================
exports.onItemAdded = functions.database
    .ref(`/${ROOT}/Businesses/{bizId}/Inventory/{itemId}`)
    .onCreate(async (snapshot, context) => {
        const { bizId } = context.params;
        const settings = await getSettings(bizId);
        if (settings.notifyItemAdded === false) return null;

        const item = snapshot.val() || {};
        const addedBy = item.addedBy ? ` by ${item.addedBy}` : '';

        return sendToBusiness(bizId, {
            title: `${item.name || 'New item'} added`,
            body: `${item.sku || ''} · starting stock ${item.total || 0}${addedBy}`,
            tag: 'item_added',
            url: './',
            count: BADGE_HINT
        });
    });

// ============================================================
// (Optional but recommended) Low / out-of-stock, checked whenever
// an inventory item is updated — covers restocks driving it back up
// and sales driving it down.
// ============================================================
exports.onInventoryChanged = functions.database
    .ref(`/${ROOT}/Businesses/{bizId}/Inventory/{itemId}`)
    .onUpdate(async (change, context) => {
        const { bizId } = context.params;
        const settings = await getSettings(bizId);
        if (settings.notifyLowStock === false) return null;

        const before = change.before.val() || {};
        const after = change.after.val() || {};
        const low = typeof settings.lowStockThreshold === 'number' ? settings.lowStockThreshold : 5;

        const wasOk = (before.available || 0) > low;
        const nowLow = (after.available || 0) <= low && (after.available || 0) > 0;
        const nowOut = (after.available || 0) === 0;
        const wasOut = (before.available || 0) === 0;

        if (nowOut && !wasOut) {
            return sendToBusiness(bizId, {
                title: `${after.name || 'Item'} is out of stock`,
                body: `${after.sku || ''} · 0 units left. Restock soon.`,
                tag: `stock:${context.params.itemId}`,
                url: './',
                count: BADGE_HINT
            });
        }
        if (nowLow && wasOk) {
            return sendToBusiness(bizId, {
                title: `${after.name || 'Item'} is running low`,
                body: `${after.sku || ''} · only ${after.available} unit${after.available === 1 ? '' : 's'} left.`,
                tag: `stock:${context.params.itemId}`,
                url: './',
                count: BADGE_HINT
            });
        }
        return null;
    });
