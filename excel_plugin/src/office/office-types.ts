export interface AsyncResult<T> {
  status: "succeeded" | "failed" | string;
  value: T;
  error?: { message: string };
}

export interface FileLike {
  size: number;
  sliceCount: number;
  getSliceAsync(i: number, cb: (r: AsyncResult<{ data: number[] }>) => void): void;
  closeAsync(): void;
}

export interface DocumentHost {
  url: string;
  getFileAsync(type: "compressed", opts: { sliceSize: number }, cb: (r: AsyncResult<FileLike>) => void): void;
}
