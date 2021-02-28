interface Listener<TValue = void> {
  resolve(value: TValue): void;
  reject(error: unknown): void;
}

type ListenerStatus = "pending" | "resolved" | "rejected";

interface QueuedListener<TValue = void> extends Listener<TValue> {
  apply<TListener extends Listener<TValue>>(listener: TListener): void;
  resolved: TValue | undefined;
  rejected: unknown | undefined;
  status: ListenerStatus;
}

interface BufferedListener<TChunk = void, TValue = void>
  extends QueuedListener<TValue> {
  apply<TListener extends Listener<TValue>>(
    listener: TListener,
    ingest?: (chunk: TChunk, listener: Listener<TValue>) => TChunk | undefined
  ): void;
  ingest(chunk: TChunk): void;
  buffer: TChunk[];
}

function createBufferedListener<TChunk = void, TValue = void>(
  buffer: TChunk[] = []
): BufferedListener<TChunk, TValue> {
  let resolve: (value: TValue) => void | undefined;
  let reject: (error: unknown) => void | undefined;

  const bufferedListener: BufferedListener<TChunk, TValue> = {
    resolve(value) {
      if (bufferedListener.status === "pending") {
        bufferedListener.resolved = value;
        bufferedListener.status = "resolved";

        if (resolve) {
          resolve(value);
        }
      }
    },
    reject(error) {
      if (bufferedListener.status === "pending") {
        bufferedListener.rejected = error;
        bufferedListener.status = "rejected";

        if (reject) {
          reject(error);
        }
      }
    },
    ingest(chunk: TChunk) {
      bufferedListener.buffer.push(chunk);
    },
    apply(listener, ingest) {
      switch (bufferedListener.status) {
        case "resolved":
          listener.resolve(bufferedListener.resolved!);
          break;
        case "rejected":
          listener.reject(bufferedListener.rejected);
          break;
        case "pending":
          resolve = listener.resolve;
          reject = listener.reject;
          break;
      }

      if (ingest) {
        const ingestListener: Listener<TValue> = {
          resolve(value) {
            if (bufferedListener.status === "pending") {
              bufferedListener.resolved = value;
              bufferedListener.status = "resolved";
            }
          },
          reject(error) {
            if (bufferedListener.status === "pending") {
              bufferedListener.rejected = error;
              bufferedListener.status = "rejected";
            }
          },
        };

        const applyStatusChange = () => {
          switch (bufferedListener.status) {
            case "resolved":
              listener.resolve(bufferedListener.resolved!);
              break;
            case "rejected":
              listener.reject(bufferedListener.rejected);
              break;
          }
        };

        bufferedListener.ingest = (chunk: TChunk) => {
          if (bufferedListener.status === "pending") {
            const ingestedChunk = ingest(chunk, ingestListener);

            if (ingestedChunk) {
              bufferedListener.buffer.push(ingestedChunk);
            }

            applyStatusChange();
          } else {
            bufferedListener.buffer.push(chunk);
          }
        };

        // process buffer
        bufferedListener.buffer = bufferedListener.buffer
          .map((chunk) => {
            if (bufferedListener.status === "pending") {
              return ingest(chunk, ingestListener);
            } else {
              return chunk;
            }
          })
          .filter((chunk) => chunk !== undefined) as TChunk[];

        applyStatusChange();
      }
    },
    resolved: undefined,
    rejected: undefined,
    status: "pending",
    buffer: [...buffer],
  };

  return bufferedListener;
}

export { Listener, QueuedListener, BufferedListener, createBufferedListener };
