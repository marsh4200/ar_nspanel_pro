# Media3 RTSP module, vendored (AR Smart Home)

This folder is `androidx/media` **1.5.1** `libraries/exoplayer_rtsp/src/main/java`, unchanged
(Apache License 2.0, Copyright The Android Open Source Project) except for one fix:

- `reader/RtpH265Reader.java`: the RTP sequence-number rollover check used
  `% RtpPacket.MAX_SEQUENCE_NUMBER` (65535) instead of `RtpPacket.getNextSequenceNumber()`,
  so packet 65535 was dropped at every counter rollover. On H.265 cameras that broke a
  picture about every 90 s and the panel showed green / stale frames until the next keyframe.
  Still present upstream in 1.11.1.

It replaces the `androidx.media3:media3-exoplayer-rtsp` dependency (see app/build.gradle.kts).
When moving Media3 to a newer version, copy that version's module here and re-apply the fix
(or drop this folder once upstream fixes it).
