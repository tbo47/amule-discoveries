const AmuleClient = require('./../AmuleClient');

const AMULE_HOST = process.env.AMULE_HOST || '127.0.0.1';
const AMULE_PORT = process.env.AMULE_PORT || 4712;
const AMULE_PASSWORD = process.env.AMULE_PASSWORD || 'admin';
const DEBUG = true;

const amuleClient = new AmuleClient(AMULE_HOST, AMULE_PORT, AMULE_PASSWORD);

(async function init() {
  try {
    await amuleClient.connect();
    if (DEBUG) console.log('Connected and authenticated successfully to aMule');
  } catch (error) {
    console.error('Could not connect to aMule:', error);
    process.exit(1);
  }

  try {
    const stats = await amuleClient.getStats();
    console.dir(stats, { depth: null });
  } catch (error) {
    console.error('Error executing aMule commands:', error);
  }

  try {
    const sharedFiles = await amuleClient.getSharedFiles();
    const names = sharedFiles.map(file => file.fileName).sort();
    console.dir(names, { depth: null });
  } catch (error) {
    console.error('Error executing aMule commands:', error);
  }

  /*
  this guy is sharing list
  {
      _value: 29977,
      EC_TAG_CLIENT_NAME: 'https://www.emule-project.org',
      EC_TAG_CLIENT_HASH: 'd931076ce30e91cd59805fb0daab6fca',
      EC_TAG_CLIENT_USER_ID: 8731832,
      EC_TAG_CLIENT_SCORE: 0,
      EC_TAG_CLIENT_SOFTWARE: 0,
      EC_TAG_CLIENT_SOFT_VER_STR: 'v0.70b',
      EC_TAG_CLIENT_USER_IP: 2749238317,
      EC_TAG_CLIENT_USER_PORT: 35278,
      EC_TAG_CLIENT_FROM: 0,
      EC_TAG_CLIENT_SERVER_IP: 2248339345,
      EC_TAG_CLIENT_SERVER_PORT: 4661,
      EC_TAG_CLIENT_SERVER_NAME: 'GrupoTS Server',
      EC_TAG_CLIENT_UP_SPEED: 98640,
      EC_TAG_CLIENT_UPLOAD_SESSION: 507963250,
      EC_TAG_PARTFILE_SIZE_XFER: 0,
      EC_TAG_CLIENT_UPLOAD_TOTAL: 1291486848,
      EC_TAG_CLIENT_DOWNLOAD_TOTAL: 0,
      EC_TAG_CLIENT_UPLOAD_STATE: 0,
      EC_TAG_CLIENT_DOWNLOAD_STATE: 13,
      EC_TAG_CLIENT_IDENT_STATE: 2,
      EC_TAG_CLIENT_EXT_PROTOCOL: 1,
      EC_TAG_CLIENT_WAITING_POSITION: 0,
      EC_TAG_CLIENT_REMOTE_QUEUE_RANK: 0,
      EC_TAG_CLIENT_OLD_REMOTE_QUEUE_RANK: 0,
      EC_TAG_CLIENT_OBFUSCATION_STATUS: 2,
      EC_TAG_CLIENT_KAD_PORT: 8803,
      EC_TAG_CLIENT_FRIEND_SLOT: 0,
      EC_TAG_PARTFILE_NAME: 'ArteTv - Le complot Caravaggio (2⧸6) (2026 clo2).mp4',
      EC_TAG_CLIENT_UPLOAD_FILE: 414,
      EC_TAG_CLIENT_REQUEST_FILE: 0,
      EC_TAG_CLIENT_REMOTE_FILENAME: ''
    }*/
  try {
    // EC_TAG_CLIENT_HASH: 'd931076ce30e91cd59805fb0daab6fca',
    // EC_TAG_CLIENT_USER_ID: 8731832,
    const uploadingQueue = await amuleClient.getUploadingQueue();
    console.dir(uploadingQueue, { depth: null });
  } catch (error) {
    console.error('Error executing aMule commands:', error);
  }

  try {
    const clientSharedFileList = await amuleClient.requestClientSharedFileList(8731832);
    console.dir(clientSharedFileList, { depth: null });
  } catch (error) {
    console.error('Error executing aMule commands:', error);
  }
})();
