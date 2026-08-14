export type StreamMeta = {
  title: string;
  summary: string;
  image: string;
  tags?: string[];
};

export enum StreamMetaImageChoice {
  Default = 'default',
  Thumbnail = 'thumbnail',
  Image = 'image',
  Url = 'url',
}

