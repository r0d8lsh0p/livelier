/**
 * ProfileService read-path tests.
 *
 * getProfile/getProfiles delegate to the shared profileRequestCoordinator
 * singleton, which owns all fetch coordination (cache-first partitioning,
 * cross-caller in-flight dedup, bounded backoff, retry heartbeat). Those
 * behaviours are unit-tested in profile-request-coordinator.test.ts — here we
 * verify the service hands reads to the coordinator and returns its results.
 */
import profileService from './profile.service';
import coordinator from './profile-request-coordinator';

jest.mock('./profile-request-coordinator', () => ({
  __esModule: true,
  default: {
    getProfile: jest.fn(),
    getProfiles: jest.fn(),
  },
}));

const mockedCoordinator = coordinator as jest.Mocked<typeof coordinator>;

const PROFILE = { name: 'Alice', picture: 'https://example.com/p.png', timestamp: 1 };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ProfileService read paths', () => {
  it('getProfile delegates to the coordinator and returns its result', async () => {
    mockedCoordinator.getProfile.mockResolvedValue(PROFILE);

    const result = await profileService.getProfile('pk_a');

    expect(mockedCoordinator.getProfile).toHaveBeenCalledWith('pk_a');
    expect(result).toEqual(PROFILE);
  });

  it('getProfile returns null when the coordinator cannot resolve the profile', async () => {
    mockedCoordinator.getProfile.mockResolvedValue(null);

    await expect(profileService.getProfile('pk_missing')).resolves.toBeNull();
  });

  it('getProfiles delegates the whole batch to the coordinator', async () => {
    mockedCoordinator.getProfiles.mockResolvedValue({ pk_a: PROFILE, pk_b: null });

    const result = await profileService.getProfiles(['pk_a', 'pk_b']);

    expect(mockedCoordinator.getProfiles).toHaveBeenCalledTimes(1);
    expect(mockedCoordinator.getProfiles).toHaveBeenCalledWith(['pk_a', 'pk_b']);
    expect(result).toEqual({ pk_a: PROFILE, pk_b: null });
  });
});
