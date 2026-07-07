const { SonosManager } = require('@svrooij/sonos');

/**
 * Thin wrapper around @svrooij/sonos.
 *
 * Playback strategy: for each target speaker we clear its queue, enqueue the
 * loop WAV URL, point the transport at the speaker's own queue
 * (x-rincon-queue:UUID#0), set REPEAT_ALL and hit play. Using the queue (as
 * opposed to setting the URI directly) is what makes REPEAT_ALL actually loop.
 *
 * Sync mode: independent playback on multiple speakers will drift slightly.
 * "grouped" mode joins all selected speakers to the first one (the
 * coordinator) so Sonos keeps them sample-synced, then plays on the
 * coordinator only.
 */

let manager = null;
let initPromise = null;

async function getManager() {
  if (manager) return manager;
  if (!initPromise) {
    const m = new SonosManager();

    // If SONOS_HOST is set, skip multicast discovery entirely and bootstrap
    // from that one speaker — it reports the whole household's topology, so
    // every speaker still shows up. This sidesteps blocked SSDP (macOS Local
    // Network permission, VPNs, AP isolation).
    const init = process.env.SONOS_HOST
      ? m.InitializeFromDevice(process.env.SONOS_HOST)
      : m.InitializeWithDiscovery(15);

    initPromise = init
      .then(() => {
        manager = m;
        console.log(
          `  Sonos: found ${m.Devices.length} device(s): ${m.Devices.map((d) => d.Name).join(', ')}`
        );
        return m;
      })
      .catch((err) => {
        initPromise = null;
        const hint = process.env.SONOS_HOST
          ? `Could not reach speaker at ${process.env.SONOS_HOST}`
          : 'Multicast discovery failed — set SONOS_HOST=<speaker-ip> in .env to bypass it';
        throw new Error(`${err.message}. ${hint}`);
      });
  }
  return initPromise;
}

function findDevice(m, uuid) {
  const d = m.Devices.find((dev) => dev.Uuid === uuid);
  if (!d) throw new Error(`Speaker ${uuid} not found`);
  return d;
}

async function listSpeakers() {
  const m = await getManager();
  const speakers = [];
  for (const d of m.Devices) {
    let volume = null;
    try {
      const v = await d.RenderingControlService.GetVolume({
        InstanceID: 0,
        Channel: 'Master',
      });
      volume = v.CurrentVolume;
    } catch (e) {
      // leave volume null; UI shows a dash
    }
    speakers.push({
      uuid: d.Uuid,
      name: d.Name,
      host: d.Host,
      groupName: d.GroupName || d.Name,
    });
    speakers[speakers.length - 1].volume = volume;
  }
  return speakers;
}

async function setVolume(uuid, volume) {
  const m = await getManager();
  const d = findDevice(m, uuid);
  await d.RenderingControlService.SetVolume({
    InstanceID: 0,
    Channel: 'Master',
    DesiredVolume: Math.max(0, Math.min(100, Math.round(volume))),
  });
}

async function playLoopOnDevice(d, url) {
  const avt = d.AVTransportService;
  // Make sure the device is playing from its own queue, not a group/stream
  try {
    await avt.BecomeCoordinatorOfStandaloneGroup({ InstanceID: 0 });
  } catch (e) {
    /* already standalone */
  }
  await avt.RemoveAllTracksFromQueue({ InstanceID: 0 });
  await avt.AddURIToQueue({
    InstanceID: 0,
    EnqueuedURI: url,
    EnqueuedURIMetaData: '',
    DesiredFirstTrackNumberEnqueued: 0,
    EnqueueAsNext: false,
  });
  await avt.SetAVTransportURI({
    InstanceID: 0,
    CurrentURI: `x-rincon-queue:${d.Uuid}#0`,
    CurrentURIMetaData: '',
  });
  await avt.SetPlayMode({ InstanceID: 0, NewPlayMode: 'REPEAT_ALL' });
  await avt.Play({ InstanceID: 0, Speed: '1' });
}

async function play(uuids, url, mode = 'independent') {
  const m = await getManager();
  const devices = uuids.map((u) => findDevice(m, u));
  if (devices.length === 0) throw new Error('No speakers selected');

  if (mode === 'grouped' && devices.length > 1) {
    const [coordinator, ...members] = devices;
    await playLoopOnDevice(coordinator, url);
    for (const member of members) {
      await member.AVTransportService.SetAVTransportURI({
        InstanceID: 0,
        CurrentURI: `x-rincon:${coordinator.Uuid}`,
        CurrentURIMetaData: '',
      });
    }
    return { mode: 'grouped', coordinator: coordinator.Name };
  }

  await Promise.all(devices.map((d) => playLoopOnDevice(d, url)));
  return { mode: 'independent' };
}

async function stop(uuids) {
  const m = await getManager();
  const results = [];
  for (const uuid of uuids) {
    const d = findDevice(m, uuid);
    try {
      // Leave any group first so Stop applies to this device
      try {
        await d.AVTransportService.BecomeCoordinatorOfStandaloneGroup({
          InstanceID: 0,
        });
      } catch (e) {
        /* already standalone */
      }
      await d.AVTransportService.Stop({ InstanceID: 0 });
      results.push({ uuid, stopped: true });
    } catch (e) {
      results.push({ uuid, stopped: false, error: e.message });
    }
  }
  return results;
}

module.exports = { listSpeakers, setVolume, play, stop };
