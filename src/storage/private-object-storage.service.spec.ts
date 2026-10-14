import { ConfigService } from '@nestjs/config';
import { PrivateObjectStorageService } from './private-object-storage.service';

describe('PrivateObjectStorageService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the current Supabase secret key only as an API key', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const config = {
      get: jest.fn((key: string) =>
        ({
          SUPABASE_URL: 'https://project.supabase.co',
          SUPABASE_SECRET_KEY: 'sb_secret_project-key',
          SUPABASE_STORAGE_BUCKET: 'delivery-proofs',
        })[key],
      ),
    } as unknown as ConfigService;
    const service = new PrivateObjectStorageService(config);

    await service.putObject('requests/file.jpg', Buffer.from('image'), 'image/jpeg');

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toEqual(
      expect.objectContaining({ apikey: 'sb_secret_project-key' }),
    );
    expect(init?.headers).not.toHaveProperty('Authorization');
  });
});
