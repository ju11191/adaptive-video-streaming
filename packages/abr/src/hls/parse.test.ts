import { describe, expect, it } from 'vitest';
import { parseAttributes, parseMaster, parseMedia, resolveUri } from './parse.ts';

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=832000,AVERAGE-BANDWIDTH=298000,RESOLUTION=426x240,CODECS="avc1.640028",FRAME-RATE=30.000
v0/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4730000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"

v5/playlist.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init_0.mp4"
#EXTINF:4.000000,
seg_0.m4s
#EXTINF:3.5,
seg_1.m4s
#EXT-X-ENDLIST
`;

describe('HLS parsing', () => {
  it('parses quoted attributes containing commas', () => {
    expect(parseAttributes('A=1,CODECS="x,y",B=two')).toEqual({ A: '1', CODECS: 'x,y', B: 'two' });
  });
  it('parses master variants', () => {
    const v = parseMaster(MASTER);
    expect(v).toHaveLength(2);
    expect(v[0]).toEqual({
      uri: 'v0/playlist.m3u8',
      bandwidth: 832000,
      averageBandwidth: 298000,
      width: 426,
      height: 240,
      codecs: 'avc1.640028',
    });
    expect(v[1]!.averageBandwidth).toBeNull();
    expect(v[1]!.codecs).toBe('avc1.640028,mp4a.40.2');
    expect(v[1]!.uri).toBe('v5/playlist.m3u8');
  });
  it('parses media playlists', () => {
    const m = parseMedia(MEDIA);
    expect(m.targetDurationS).toBe(4);
    expect(m.initUri).toBe('init_0.mp4');
    expect(m.segments).toEqual([
      { uri: 'seg_0.m4s', durationS: 4 },
      { uri: 'seg_1.m4s', durationS: 3.5 },
    ]);
    expect(m.endList).toBe(true);
  });
  it('rejects non-playlists and orphan segments', () => {
    expect(() => parseMaster('hello')).toThrow();
    expect(() => parseMaster('#EXTM3U\n')).toThrow();
    expect(() => parseMedia('#EXTM3U\nseg.m4s\n')).toThrow();
  });
  it('resolves relative URIs', () => {
    expect(resolveUri('http://h:8080/media/hls/master.m3u8', 'v0/playlist.m3u8')).toBe(
      'http://h:8080/media/hls/v0/playlist.m3u8',
    );
    expect(resolveUri('http://h/a/v0/playlist.m3u8', 'seg_1.m4s?x=1')).toBe('http://h/a/v0/seg_1.m4s?x=1');
  });
});
