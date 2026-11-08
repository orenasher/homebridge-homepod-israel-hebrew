'use strict';

const { HomePodSayPlatform, PLATFORM_NAME, PLUGIN_NAME } = require('./src/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HomePodSayPlatform);
};
