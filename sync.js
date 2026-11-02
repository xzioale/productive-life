// Sincronizzazione con Supabase.
// Ogni dato dell'app (abitudini, attività, conti, transazioni...) è già salvato sul dispositivo con saveLS:
// qui ogni salvataggio viene copiato anche nella tabella app_state, una riga per chiave.
// Gli altri dispositivi ricevono l'avviso in tempo reale e scaricano la versione nuova.
// Se si è offline le modifiche restano "in sospeso" e partono appena torna la connessione.
(function () {
    const cfg = window.PL_CONFIG || {};
    const configured = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
    const SYNC_KEYS = [
        'productive_fin_categories', 'productive_fin_accounts', 'productive_fin_transactions',
        'productive_fin_recurring', 'productive_habits', 'productive_tasks',
        'productive_tasks_hide_done', 'productive_theme',
        'productive_fin_autorules', 'productive_ingest_token'
    ];

    const client = configured && window.supabase
        ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } })
        : null;

    let user = null;
    let status = 'offline';
    let pendingInit = null;
    let appStarted = false;
    let channel = null;
    let pullTimer = null;
    let pendingTimer = null;
    let pending = [];
    const pushTimers = {};

    const DEVICE_ID = (() => {
        let id = readRaw('pl_device_id');
        if (!id) { id = 'dev_' + Math.random().toString(36).slice(2, 10); writeLocalRaw('pl_device_id', id); }
        return id;
    })();

    // Chiavi modificate qui e non ancora arrivate al cloud.
    function getDirty() { return loadLS('pl_dirty') || []; }
    function setDirty(list) { writeLocalRaw('pl_dirty', JSON.stringify([...new Set(list)])); }

    function withTimeout(promise, ms) {
        return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve({ error: { message: 'timeout' } }), ms))]);
    }

    function setStatus(s) {
        status = s;
        const dot = document.getElementById('syncDot');
        if (dot) {
            dot.classList.remove('hidden', 'bg-emerald-500', 'bg-amber-400', 'bg-zinc-400');
            dot.classList.add(s === 'ok' ? 'bg-emerald-500' : (s === 'saving' ? 'bg-amber-400' : 'bg-zinc-400'));
            dot.title = statusLabel();
        }
        const txt = document.getElementById('syncStatusText');
        if (txt) txt.textContent = statusLabel();
    }

    function statusLabel() {
        if (status === 'ok') return 'Sincronizzato';
        if (status === 'saving') return 'Sincronizzazione in corso…';
        const n = getDirty().length;
        return n ? `Offline: ${n} modifiche in attesa di invio` : 'Offline';
    }

    function onLocalSave(k) {
        if (!configured || !SYNC_KEYS.includes(k)) return;
        setDirty(getDirty().concat(k));
        if (!user || !client) { setStatus('offline'); return; }
        clearTimeout(pushTimers[k]);
        pushTimers[k] = setTimeout(() => push([k]), 400);
    }

    async function push(keys) {
        if (!user || !client || keys.length === 0) return true;
        const rows = keys
            .map(k => ({ user_id: user.id, key: k, value: readRaw(k), device_id: DEVICE_ID, updated_at: new Date().toISOString() }))
            .filter(r => r.value !== null);
        if (rows.length === 0) return true;
        setStatus('saving');
        const { error } = await withTimeout(client.from('app_state').upsert(rows), 10000);
        if (error) { setStatus('offline'); return false; }
        setDirty(getDirty().filter(k => !keys.includes(k)));
        setStatus(getDirty().length ? 'saving' : 'ok');
        return true;
    }

    async function fetchRemote() {
        const { data, error } = await withTimeout(client.from('app_state').select('key,value'), 10000);
        if (error) { setStatus('offline'); return null; }
        return data || [];
    }

    // Scrive sul dispositivo i dati arrivati dal cloud (tranne quelli modificati qui e non ancora inviati).
    function applyRemote(rows) {
        const dirty = getDirty();
        let changed = false;
        rows.forEach(r => {
            if (!SYNC_KEYS.includes(r.key) || dirty.includes(r.key) || r.value == null) return;
            if (readRaw(r.key) === r.value) return;
            writeLocalRaw(r.key, r.value);
            changed = true;
        });
        return changed;
    }

    async function syncDown() {
        if (!user || !client) return;
        const rows = await fetchRemote();
        if (!rows) return;
        if (applyRemote(rows) && appStarted) {
            reloadStateFromStorage();
            refreshAllViews();
        }
        setStatus(getDirty().length ? 'saving' : 'ok');
        await loadPending();
    }

    // Pagamenti arrivati dall'iPhone (Apple Pay o comando rapido) in attesa di conferma.
    async function loadPending() {
        if (!user || !client) return;
        const { data, error } = await withTimeout(client.from('pending_payments').select('*').order('created_at', { ascending: true }), 10000);
        if (error) return;
        pending = data || [];
        if (appStarted && window.onPendingPayments) window.onPendingPayments(pending);
    }

    // Toglie un pagamento dalla lista d'attesa. Restituisce true solo al dispositivo che lo ha tolto per primo,
    // così lo stesso pagamento non diventa due transazioni se PC e iPhone confermano insieme.
    // null = nessuna connessione.
    async function claimPending(id) {
        if (!user || !client) return null;
        const { data, error } = await withTimeout(client.from('pending_payments').delete().eq('id', id).select('id'), 10000);
        if (error) return null;
        pending = pending.filter(p => p.id !== id);
        return !!(data && data.length);
    }

    async function createIngestToken() {
        if (!user || !client) return null;
        const { data, error } = await client.rpc('create_ingest_token');
        return error ? null : data;
    }

    // Invia un pagamento di prova come farebbe il comando dell'iPhone.
    async function sendTestPayment(token) {
        try {
            const res = await fetch(cfg.supabaseUrl + '/rest/v1/rpc/ingest_payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
                body: JSON.stringify({ token, amount: '€1,23', merchant: 'Pagamento di prova', card: 'Prova' })
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    async function syncNow() {
        if (!user || !client) return;
        await push(getDirty());
        await syncDown();
    }

    function subscribe() {
        if (channel || !client || !user) return;
        channel = client
            .channel('app_state_' + user.id)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state', filter: 'user_id=eq.' + user.id }, () => {
                clearTimeout(pullTimer);
                pullTimer = setTimeout(syncDown, 300);
            })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pending_payments', filter: 'user_id=eq.' + user.id }, () => {
                clearTimeout(pendingTimer);
                pendingTimer = setTimeout(loadPending, 300);
            })
            .subscribe();
    }

    async function afterLogin() {
        hideLogin();
        setStatus('saving');
        await push(getDirty());
        const rows = await fetchRemote();
        if (rows && rows.length === 0) {
            // Primo accesso in assoluto: il cloud è vuoto, si caricano i dati di questo dispositivo.
            await push(SYNC_KEYS.filter(k => readRaw(k) !== null));
        } else if (rows) {
            applyRemote(rows);
            setStatus(getDirty().length ? 'saving' : 'ok');
        }
        reloadStateFromStorage();
        if (!appStarted) {
            appStarted = true;
            if (pendingInit) pendingInit();
        } else {
            refreshAllViews();
        }
        subscribe();
        loadPending();
    }

    async function start(initApp) {
        pendingInit = initApp;
        if (!client) {
            // Libreria non caricata (es. primo avvio senza rete): l'app parte coi dati del dispositivo.
            appStarted = true;
            setStatus('offline');
            initApp();
            return;
        }
        const { data } = await client.auth.getSession();
        user = data && data.session ? data.session.user : null;
        if (!user) { showLogin(); return; }
        await afterLogin();
    }

    function showLogin() {
        const el = document.getElementById('authScreen');
        if (el) el.classList.remove('hidden');
    }

    function hideLogin() {
        const el = document.getElementById('authScreen');
        if (el) el.classList.add('hidden');
    }

    function authMessage(text, isError) {
        const el = document.getElementById('authMessage');
        if (!el) return;
        el.textContent = text;
        el.className = 'text-xs font-semibold ' + (isError ? 'text-rose-500' : 'text-emerald-500');
        el.classList.toggle('hidden', !text);
    }

    function translateAuthError(msg) {
        const m = (msg || '').toLowerCase();
        if (m.includes('invalid login')) return 'Email o password errati.';
        if (m.includes('not confirmed')) return "Devi prima confermare l'email: controlla la posta.";
        if (m.includes('already registered')) return 'Esiste già un account con questa email: accedi.';
        if (m.includes('signups not allowed') || m.includes('signup is disabled')) return 'La creazione di nuovi account è disattivata.';
        if (m.includes('password')) return 'La password deve avere almeno 6 caratteri.';
        if (m.includes('fetch') || m.includes('network') || m.includes('json') || m.includes('timeout')) return 'Server non raggiungibile: controlla la connessione e riprova.';
        return 'Errore: ' + (msg || 'riprova.');
    }

    function readCredentials() {
        return {
            email: document.getElementById('authEmail').value.trim(),
            password: document.getElementById('authPassword').value
        };
    }

    async function submitLogin(e) {
        e.preventDefault();
        const btn = document.getElementById('authSubmitBtn');
        if (btn) btn.disabled = true;
        authMessage('', false);
        const { email, password } = readCredentials();
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (btn) btn.disabled = false;
        if (error) { authMessage(translateAuthError(error.message), true); return; }
        user = data.user;
        await afterLogin();
    }

    async function signUp() {
        const form = document.getElementById('authForm');
        if (form && !form.reportValidity()) return;
        authMessage('', false);
        const { email, password } = readCredentials();
        const { data, error } = await client.auth.signUp({ email, password });
        if (error) { authMessage(translateAuthError(error.message), true); return; }
        if (data.session) {
            user = data.user;
            await afterLogin();
        } else {
            authMessage("Account creato! Conferma l'email dal link che ti è arrivato, poi accedi qui.", false);
        }
    }

    async function signOut() {
        if (!confirm('Uscire dall\'account? I dati restano salvati nel cloud e su questo dispositivo verranno cancellati.')) return;
        await syncNow();
        if (client) await client.auth.signOut();
        SYNC_KEYS.concat(['pl_dirty']).forEach(k => { try { localStorage.removeItem(k); } catch (err) {} });
        location.reload();
    }

    async function changePassword(e) {
        e.preventDefault();
        if (!client || !user) return;
        const first = document.getElementById('newPassword1').value;
        const second = document.getElementById('newPassword2').value;
        if (first !== second) { showToast('Le due password non coincidono'); return; }
        const { error } = await client.auth.updateUser({ password: first });
        if (error) { showToast(translateAuthError(error.message)); return; }
        closeModal('passwordModal');
        showToast('Password cambiata!');
    }

    function renderAccountBox() {
        const box = document.getElementById('accountBox');
        if (!box) return;
        box.classList.toggle('hidden', !user);
        if (!user) return;
        document.getElementById('accountEmail').textContent = user.email || '';
        document.getElementById('syncStatusText').textContent = statusLabel();
    }

    window.addEventListener('online', () => { syncNow(); });

    window.PLSync = {
        configured,
        isActive: () => !!(user && client),
        getPending: () => pending,
        ingestUrl: () => cfg.supabaseUrl + '/rest/v1/rpc/ingest_payment',
        anonKey: () => cfg.supabaseAnonKey,
        start, onLocalSave, syncNow, submitLogin, signUp, signOut, changePassword, renderAccountBox,
        loadPending, claimPending, createIngestToken, sendTestPayment
    };
})();
