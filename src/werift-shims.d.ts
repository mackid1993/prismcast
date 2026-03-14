// Type stubs for werift's internal dependencies that don't ship proper types.
declare module "multicast-dns" {
  namespace mdns {
    interface MulticastDNS {


      query: (...args: unknown[]) => void;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      destroy: () => void;
    }
  }
  function mdns(): mdns.MulticastDNS;
  export = mdns;
}

declare module "werift-rtp/src/rtcp/rtpfb/nack" {
  export class GenericNack {


    lost: number[];
    mediaSSRC: number;
    senderSSRC: number;
    static deSerialize(data: Buffer): GenericNack;
  }
}
