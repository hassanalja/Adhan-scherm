'use strict';

const DEFAULTS = {
  place: 'Kampen, Nederland',
  latitude: 52.555,
  longitude: 5.911,
  method: 3,
  school: 0,
  audioEnabled: true,
  volume: 0.9,
  wakeLock: true
};

const PRAYERS = [
  { key: 'Fajr', name: 'Fajr', arabic: 'الفجر', icon: '✦', adhan: true },
  { key: 'Sunrise', name: 'Zonsopkomst', arabic: 'الشروق', icon: '◒', adhan: false },
  { key: 'Dhuhr', name: 'Dhuhr', arabic: 'الظهر', icon: '☀', adhan: true },
  { key: 'Asr', name: 'Asr', arabic: 'العصر', icon: '◐', adhan: true },
  { key: 'Maghrib', name: 'Maghrib', arabic: 'المغرب', icon: '◓', adhan: true },
  { key: 'Isha', name: 'Isha', arabic: 'العشاء', icon: '☾', adhan: true }
];

const DEFAULT_ADHAN_URL = 'https://upload.wikimedia.org/wikipedia/commons/7/7d/The_Adhan_-_Muslim_Call_to_Prayer_-_Aaqib_Azeez.mp3';
const dom = {};
const state = {
  settings: loadSettings(),
  today: null,
  tomorrow: null,
  currentDateKey: localDateKey(new Date()),
  installPrompt: null,
  wakeLock: null,
  audio: new Audio(),
  customAudioUrl: null,
  isTestPlaying: false
};

window.addEventListener('DOMContentLoaded', init);

async function init() {
  mapDom();
  bindEvents();
  applySettingsToForm();
  updateClock();
  updateOnlineStatus();
  setInterval(tick, 1000);
  state.audio.preload = 'auto';
  state.audio.volume = state.settings.volume;
  state.audio.addEventListener('ended', resetAudioButton);
  state.audio.addEventListener('error', () => setStatus('De standaard audio kon niet laden. Kies eventueel een eigen audiobestand.', true));
  await loadStoredAudio();
  await registerServiceWorker();
  await refreshPrayerTimes();
  if (state.settings.wakeLock) await requestWakeLock();
}

function mapDom() {
  const ids = [
    'location-label','gregorian-date','clock','hijri-date','next-prayer-name','next-prayer-time','countdown',
    'prayer-grid','status-message','online-status','refresh-button','settings-button','settings-dialog','settings-form',
    'close-settings','cancel-settings','place-input','latitude-input','longitude-input','method-input','school-input',
    'audio-enabled-input','volume-input','wake-lock-input','gps-button','test-audio-button','audio-file-input',
    'reset-audio-button','audio-label','notification-button','fullscreen-button','install-button','adhan-overlay',
    'adhan-prayer-name','adhan-prayer-time','stop-adhan-button'
  ];
  ids.forEach((id) => { dom[toCamel(id)] = document.getElementById(id); });
}

function bindEvents() {
  dom.refreshButton.addEventListener('click', refreshPrayerTimes);
  dom.settingsButton.addEventListener('click', openSettings);
  dom.closeSettings.addEventListener('click', () => dom.settingsDialog.close());
  dom.cancelSettings.addEventListener('click', () => dom.settingsDialog.close());
  dom.settingsForm.addEventListener('submit', saveSettings);
  dom.gpsButton.addEventListener('click', useCurrentLocation);
  dom.testAudioButton.addEventListener('click', toggleAudioTest);
  dom.audioFileInput.addEventListener('change', importAudio);
  dom.resetAudioButton.addEventListener('click', resetAudio);
  dom.notificationButton.addEventListener('click', enableNotifications);
  dom.fullscreenButton.addEventListener('click', toggleFullscreen);
  dom.installButton.addEventListener('click', installApp);
  dom.stopAdhanButton.addEventListener('click', stopAdhan);
  dom.volumeInput.addEventListener('input', () => { state.audio.volume = Number(dom.volumeInput.value); });
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    dom.installButton.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    dom.installButton.hidden = true;
    setStatus('De app is geïnstalleerd.');
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      tick();
      if (state.settings.wakeLock) await requestWakeLock();
    }
  });
}

function tick() {
  const now = new Date();
  updateClock(now);
  updateCountdown(now);
  checkAdhan(now);
  const key = localDateKey(now);
  if (key !== state.currentDateKey) {
    state.currentDateKey = key;
    refreshPrayerTimes();
  }
}

function updateClock(now = new Date()) {
  const time = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
  dom.clock.textContent = time;
  dom.clock.dateTime = now.toISOString();
  dom.gregorianDate.textContent = new Intl.DateTimeFormat('nl-NL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(now);
}

async function refreshPrayerTimes() {
  dom.prayerGrid.setAttribute('aria-busy', 'true');
  setStatus('Gebedstijden worden opgehaald…');
  try {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const [todayData, tomorrowData] = await Promise.all([
      fetchSchedule(today),
      fetchSchedule(tomorrow)
    ]);
    state.today = todayData;
    state.tomorrow = tomorrowData;
    localStorage.setItem(`adhan-schedule-${todayData.dateKey}`, JSON.stringify(todayData));
    localStorage.setItem(`adhan-schedule-${tomorrowData.dateKey}`, JSON.stringify(tomorrowData));
    renderSchedule();
    const source = navigator.onLine ? 'Actuele tijden opgehaald.' : 'Offline tijden uit de cache.';
    setStatus(`${source} Controleer afwijkingen altijd bij je lokale moskee.`);
  } catch (error) {
    const cachedToday = readCachedSchedule(localDateKey(new Date()));
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const cachedTomorrow = readCachedSchedule(localDateKey(tomorrow));
    if (cachedToday) {
      state.today = cachedToday;
      state.tomorrow = cachedTomorrow;
      renderSchedule();
      setStatus('Geen verbinding: laatst opgeslagen gebedstijden worden getoond.', true);
    } else {
      renderEmptySchedule();
      setStatus('Gebedstijden konden niet worden geladen. Controleer internet en locatie-instellingen.', true);
    }
    console.error(error);
  } finally {
    dom.prayerGrid.setAttribute('aria-busy', 'false');
  }
}

async function fetchSchedule(date) {
  const dateString = `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
  const params = new URLSearchParams({
    latitude: String(state.settings.latitude),
    longitude: String(state.settings.longitude),
    method: String(state.settings.method),
    school: String(state.settings.school)
  });
  const response = await fetch(`https://api.aladhan.com/v1/timings/${dateString}?${params}`);
  if (!response.ok) throw new Error(`Gebedstijdenservice gaf status ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 200 || !payload.data?.timings) throw new Error('Onverwacht antwoord van gebedstijdenservice');
  const timings = {};
  PRAYERS.forEach((prayer) => { timings[prayer.key] = cleanTime(payload.data.timings[prayer.key]); });
  return {
    dateKey: localDateKey(date),
    timings,
    hijri: payload.data.date?.hijri || null,
    timezone: payload.data.meta?.timezone || ''
  };
}

function renderSchedule() {
  dom.locationLabel.textContent = state.settings.place;
  const next = getNextPrayer(new Date());
  dom.prayerGrid.innerHTML = PRAYERS.map((prayer) => {
    const active = next && !next.tomorrow && next.key === prayer.key ? ' active' : '';
    return `<article class="prayer-card${active}">
      <div class="prayer-icon" aria-hidden="true">${prayer.icon}</div>
      <p class="prayer-name">${prayer.name} · ${prayer.arabic}</p>
      <time class="prayer-time" datetime="${state.today.timings[prayer.key]}">${state.today.timings[prayer.key]}</time>
    </article>`;
  }).join('');
  if (state.today.hijri) {
    const h = state.today.hijri;
    dom.hijriDate.textContent = `${h.day} ${h.month?.en || ''} ${h.year} AH`;
  } else {
    dom.hijriDate.textContent = 'Islamitische datum niet beschikbaar';
  }
  updateCountdown();
}

function renderEmptySchedule() {
  dom.prayerGrid.innerHTML = PRAYERS.map((prayer) => `<article class="prayer-card">
    <div class="prayer-icon">${prayer.icon}</div><p class="prayer-name">${prayer.name} · ${prayer.arabic}</p><p class="prayer-time">--:--</p>
  </article>`).join('');
}

function getNextPrayer(now) {
  if (!state.today) return null;
  for (const prayer of PRAYERS.filter((item) => item.adhan)) {
    const at = dateAtTime(now, state.today.timings[prayer.key]);
    if (at > now) return { ...prayer, at, time: state.today.timings[prayer.key], tomorrow: false };
  }
  if (state.tomorrow) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const prayer = PRAYERS.find((item) => item.key === 'Fajr');
    const at = dateAtTime(tomorrow, state.tomorrow.timings.Fajr);
    return { ...prayer, at, time: state.tomorrow.timings.Fajr, tomorrow: true };
  }
  return null;
}

function updateCountdown(now = new Date()) {
  const next = getNextPrayer(now);
  if (!next) {
    dom.nextPrayerName.textContent = 'Tijden laden…';
    dom.nextPrayerTime.textContent = '--:--';
    dom.countdown.textContent = '--:--:--';
    return;
  }
  dom.nextPrayerName.textContent = `${next.name}${next.tomorrow ? ' morgen' : ''}`;
  dom.nextPrayerTime.textContent = next.time;
  const total = Math.max(0, Math.floor((next.at - now) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  dom.countdown.textContent = `over ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function checkAdhan(now) {
  if (!state.today || !state.settings.audioEnabled || dom.adhanOverlay.hidden === false) return;
  const current = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const prayer = PRAYERS.find((item) => item.adhan && state.today.timings[item.key] === current);
  if (!prayer) return;
  const triggerKey = `${state.today.dateKey}-${prayer.key}`;
  if (localStorage.getItem('adhan-last-trigger') === triggerKey) return;
  localStorage.setItem('adhan-last-trigger', triggerKey);
  startAdhan(prayer, current);
}

async function startAdhan(prayer, time) {
  dom.adhanPrayerName.textContent = prayer.name;
  dom.adhanPrayerTime.textContent = time;
  dom.adhanOverlay.hidden = false;
  if ('vibrate' in navigator) navigator.vibrate([400, 180, 400]);
  await showPrayerNotification(prayer, time);
  try {
    state.audio.currentTime = 0;
    state.audio.volume = state.settings.volume;
    await state.audio.play();
  } catch (error) {
    setStatus('Automatisch geluid werd door de browser geblokkeerd. Open Instellingen en druk één keer op “Test Adhan”.', true);
  }
}

function stopAdhan() {
  state.audio.pause();
  state.audio.currentTime = 0;
  dom.adhanOverlay.hidden = true;
  resetAudioButton();
}

function openSettings() {
  applySettingsToForm();
  updateNotificationButton();
  dom.settingsDialog.showModal();
}

function applySettingsToForm() {
  dom.placeInput.value = state.settings.place;
  dom.latitudeInput.value = state.settings.latitude;
  dom.longitudeInput.value = state.settings.longitude;
  dom.methodInput.value = String(state.settings.method);
  dom.schoolInput.value = String(state.settings.school);
  dom.audioEnabledInput.checked = state.settings.audioEnabled;
  dom.volumeInput.value = state.settings.volume;
  dom.wakeLockInput.checked = state.settings.wakeLock;
  dom.locationLabel.textContent = state.settings.place;
}

async function saveSettings(event) {
  event.preventDefault();
  const latitude = Number(dom.latitudeInput.value);
  const longitude = Number(dom.longitudeInput.value);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    setStatus('Vul geldige coördinaten in.', true);
    return;
  }
  state.settings = {
    place: dom.placeInput.value.trim() || 'Mijn locatie',
    latitude,
    longitude,
    method: Number(dom.methodInput.value),
    school: Number(dom.schoolInput.value),
    audioEnabled: dom.audioEnabledInput.checked,
    volume: Number(dom.volumeInput.value),
    wakeLock: dom.wakeLockInput.checked
  };
  localStorage.setItem('adhan-settings', JSON.stringify(state.settings));
  state.audio.volume = state.settings.volume;
  dom.settingsDialog.close();
  if (state.settings.wakeLock) await requestWakeLock(); else await releaseWakeLock();
  await refreshPrayerTimes();
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    setStatus('Deze browser ondersteunt geen locatiebepaling.', true);
    return;
  }
  dom.gpsButton.disabled = true;
  dom.gpsButton.textContent = 'Locatie bepalen…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      dom.latitudeInput.value = position.coords.latitude.toFixed(6);
      dom.longitudeInput.value = position.coords.longitude.toFixed(6);
      dom.placeInput.value = 'Mijn huidige locatie';
      dom.gpsButton.disabled = false;
      dom.gpsButton.textContent = '✓ Locatie ingevuld';
    },
    () => {
      dom.gpsButton.disabled = false;
      dom.gpsButton.textContent = '⌖ Gebruik mijn huidige locatie';
      setStatus('Locatie kon niet worden bepaald. Controleer de browsertoestemming.', true);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }
  );
}

async function toggleAudioTest() {
  if (!state.audio.paused) {
    state.audio.pause();
    state.audio.currentTime = 0;
    resetAudioButton();
    return;
  }
  try {
    state.audio.volume = Number(dom.volumeInput.value);
    state.audio.currentTime = 0;
    await state.audio.play();
    state.isTestPlaying = true;
    dom.testAudioButton.textContent = '■ Stop test';
  } catch (error) {
    setStatus('Audio kon niet worden afgespeeld. Kies een eigen MP3 of controleer de internetverbinding.', true);
  }
}

function resetAudioButton() {
  state.isTestPlaying = false;
  if (dom.testAudioButton) dom.testAudioButton.textContent = '▶ Test Adhan';
}

async function importAudio(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    setStatus('Kies een geldig audiobestand.', true);
    return;
  }
  try {
    await saveAudioBlob(file, file.name);
    setAudioSource(file, file.name);
    dom.audioLabel.textContent = `Eigen audio: ${file.name}`;
    setStatus('Eigen Adhan-audio is op dit apparaat opgeslagen.');
  } catch (error) {
    setStatus('Het audiobestand kon niet lokaal worden opgeslagen.', true);
  }
}

async function resetAudio() {
  await deleteStoredAudio();
  setAudioSource(DEFAULT_ADHAN_URL, 'Standaard Adhan');
  dom.audioLabel.textContent = 'Standaard Adhan (CC BY-SA 4.0)';
  setStatus('Standaard Adhan hersteld.');
}

function setAudioSource(source, label) {
  state.audio.pause();
  if (state.customAudioUrl) URL.revokeObjectURL(state.customAudioUrl);
  if (source instanceof Blob) {
    state.customAudioUrl = URL.createObjectURL(source);
    state.audio.src = state.customAudioUrl;
  } else {
    state.customAudioUrl = null;
    state.audio.src = source;
  }
  state.audio.load();
  if (label) state.audio.dataset.label = label;
}

async function loadStoredAudio() {
  try {
    const stored = await getAudioBlob();
    if (stored?.blob) {
      setAudioSource(stored.blob, stored.name);
      dom.audioLabel.textContent = `Eigen audio: ${stored.name}`;
      return;
    }
  } catch (error) {
    console.warn('Eigen audio kon niet worden geladen', error);
  }
  setAudioSource(DEFAULT_ADHAN_URL, 'Standaard Adhan');
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    dom.notificationButton.textContent = 'Meldingen niet ondersteund';
    return;
  }
  const result = await Notification.requestPermission();
  updateNotificationButton();
  setStatus(result === 'granted' ? 'Meldingen zijn ingeschakeld.' : 'Meldingen zijn niet toegestaan.', result !== 'granted');
}

function updateNotificationButton() {
  if (!('Notification' in window)) {
    dom.notificationButton.textContent = 'Meldingen niet ondersteund';
    dom.notificationButton.disabled = true;
  } else if (Notification.permission === 'granted') {
    dom.notificationButton.textContent = '✓ Meldingen ingeschakeld';
  } else if (Notification.permission === 'denied') {
    dom.notificationButton.textContent = 'Meldingen geblokkeerd in browser';
  } else {
    dom.notificationButton.textContent = 'Meldingen inschakelen';
  }
}

async function showPrayerNotification(prayer, time) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const registration = await navigator.serviceWorker?.ready;
  const options = {
    body: `${prayer.name} om ${time} in ${state.settings.place}`,
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/icon-192.png',
    tag: `adhan-${state.today.dateKey}-${prayer.key}`,
    renotify: true
  };
  if (registration) await registration.showNotification('Tijd voor het gebed', options);
  else new Notification('Tijd voor het gebed', options);
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    if (!state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch (error) {
    console.warn('Wake lock niet beschikbaar', error);
  }
}

async function releaseWakeLock() {
  if (state.wakeLock) await state.wakeLock.release();
  state.wakeLock = null;
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch (error) {
    setStatus('Volledig scherm wordt door deze browser niet ondersteund.', true);
  }
}

async function installApp() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  dom.installButton.hidden = true;
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./service-worker.js'); }
    catch (error) { console.warn('Offline service worker kon niet starten', error); }
  }
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  dom.onlineStatus.textContent = online ? '● Online' : '● Offline';
  dom.onlineStatus.className = online ? 'online' : 'offline';
}

function setStatus(message, isError = false) {
  dom.statusMessage.textContent = message;
  dom.statusMessage.className = `status${isError ? ' error' : ''}`;
}

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('adhan-settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}

function readCachedSchedule(key) {
  try { return JSON.parse(localStorage.getItem(`adhan-schedule-${key}`)); }
  catch { return null; }
}

function cleanTime(value) {
  const match = String(value || '').match(/\d{2}:\d{2}/);
  return match ? match[0] : '--:--';
}

function dateAtTime(base, value) {
  const [hours, minutes] = value.split(':').map(Number);
  const date = new Date(base);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) { return String(value).padStart(2, '0'); }
function toCamel(value) { return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); }

function openAudioDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('adhan-scherm', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('audio');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveAudioBlob(blob, name) {
  const db = await openAudioDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').put({ blob, name }, 'custom');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getAudioBlob() {
  const db = await openAudioDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readonly');
    const request = tx.objectStore('audio').get('custom');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

async function deleteStoredAudio() {
  const db = await openAudioDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').delete('custom');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
