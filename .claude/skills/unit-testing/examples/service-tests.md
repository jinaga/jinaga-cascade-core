# Service Testing Examples

Complete examples of testing TypeScript services and functions with vitest using fake implementations.

## Service Function Complete Example

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ShowService } from './showService';
import { FakeShowRepository } from './fakeShowRepository';
import { givenShow, givenVenue, givenAct } from './test-helpers';

describe('ShowService', () => {
  let service: ShowService;
  let fakeRepository: FakeShowRepository;
  
  beforeEach(() => {
    fakeRepository = new FakeShowRepository();
    service = new ShowService(fakeRepository);
  });

  it('should create a show with valid data', async () => {
    // Given: Valid act, venue, and show data
    const venue = givenVenue({ seatingCapacity: 1000 });
    const act = givenAct();
    const showData = {
      venueId: venue.id,
      ticketCount: 500,
      startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    };
    
    // Pre-populate repository with venue
    fakeRepository.withVenue(venue);

    // When: Creating a show
    const result = await service.createShow(act.id, showData);

    // Then: The show is created and saved
    expect(result).toBeDefined();
    expect(result.ticketCount).toBe(500);
    expect(fakeRepository.getShowCount()).toBe(1);
    expect(fakeRepository.getShow(result.id)).toEqual(result);
  });

  it('should throw error when ticket count exceeds venue capacity', async () => {
    // Given: A venue with limited capacity
    const venue = givenVenue({ seatingCapacity: 100 });
    const act = givenAct();
    const showData = {
      venueId: venue.id,
      ticketCount: 500, // Exceeds capacity of 100
      startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    };
    
    fakeRepository.withVenue(venue);

    // When: Creating a show with ticket count exceeding capacity
    const create = async () => await service.createShow(act.id, showData);

    // Then: Error is thrown and show is not saved
    await expect(create()).rejects.toThrow(
      'Ticket count cannot exceed venue capacity of 100'
    );
    expect(fakeRepository.getShowCount()).toBe(0);
  });

  it('should find shows by venue', async () => {
    // Given: Multiple shows for a venue
    const venue = givenVenue();
    const act = givenAct();
    const shows = [
      givenShow(act, venue, { ticketCount: 100 }),
      givenShow(act, venue, { ticketCount: 200 })
    ];
    
    fakeRepository.withShows(shows);

    // When: Finding shows by venue
    const result = await service.findShowsByVenue(venue.id);

    // Then: Returns all shows for the venue
    expect(result).toHaveLength(2);
    expect(result[0].ticketCount).toBe(100);
    expect(result[1].ticketCount).toBe(200);
  });
});
```

## Testing Services with Fake Dependencies

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { OrderService } from './orderService';
import { FakeEmailService } from './fakeEmailService';
import { FakeOrderRepository } from './fakeOrderRepository';

describe('OrderService', () => {
  let service: OrderService;
  let fakeEmailService: FakeEmailService;
  let fakeOrderRepository: FakeOrderRepository;
  
  beforeEach(() => {
    fakeEmailService = new FakeEmailService();
    fakeOrderRepository = new FakeOrderRepository();
    service = new OrderService(fakeOrderRepository, fakeEmailService);
  });

  it('should process order and send confirmation email', async () => {
    // Given: Order data
    const order = {
      id: 'order-123',
      customerEmail: 'customer@example.com',
      items: [{ id: 'item-1', price: 10 }],
      total: 10
    };

    // When: Processing the order
    const result = await service.processOrder(order);

    // Then: Order is processed
    expect(result.success).toBe(true);
    
    // And: Order is saved
    expect(fakeOrderRepository.getOrderCount()).toBe(1);
    expect(fakeOrderRepository.getOrder('order-123')).toEqual(order);
    
    // And: Confirmation email is sent
    expect(fakeEmailService.getEmailCount()).toBe(1);
    expect(fakeEmailService.hasEmailTo('customer@example.com')).toBe(true);
    const sentEmail = fakeEmailService.getSentEmails()[0];
    expect(sentEmail.subject).toContain('order-123');
  });

  it('should handle email service failure gracefully', async () => {
    // Given: Order data and email service that throws
    const order = {
      id: 'order-123',
      customerEmail: 'customer@example.com',
      items: [{ id: 'item-1', price: 10 }],
      total: 10
    };
    
    fakeEmailService.setShouldThrow(true);

    // When: Processing the order
    const result = await service.processOrder(order);

    // Then: Order still processes but email fails
    expect(result.success).toBe(true);
    expect(fakeOrderRepository.getOrderCount()).toBe(1);
    expect(result.emailSent).toBe(false);
    expect(result.error).toContain('Email service unavailable');
  });
});
```

## Testing Services with Fake API Clients

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { UserService } from './userService';
import { FakeApiClient } from './fakeApiClient';
import { givenUser } from './test-helpers';

describe('UserService', () => {
  let service: UserService;
  let fakeApiClient: FakeApiClient;
  
  beforeEach(() => {
    fakeApiClient = new FakeApiClient();
    service = new UserService(fakeApiClient);
  });

  it('should fetch user by id', async () => {
    // Given: Mock API response configured in fake
    const mockUser = givenUser({ id: 'user-123', name: 'John Doe' });
    fakeApiClient.withResponse('GET /users/user-123', mockUser);

    // When: Fetching user
    const result = await service.getUserById('user-123');

    // Then: Returns user data
    expect(result).toEqual(mockUser);
  });

  it('should throw error when user not found', async () => {
    // Given: API configured to return null
    fakeApiClient.withResponse('GET /users/invalid', null);

    // When/Then: Throws error
    await expect(service.getUserById('invalid'))
      .rejects.toThrow('User not found');
  });

  it('should update user', async () => {
    // Given: User data to update
    const existingUser = givenUser({ id: 'user-123', name: 'John Doe' });
    const updates = { name: 'Jane Doe' };
    fakeApiClient.withResponse('GET /users/user-123', existingUser);

    // When: Updating user
    const result = await service.updateUser('user-123', updates);

    // Then: Returns updated user
    expect(result.name).toBe('Jane Doe');
    
    // And: API was called with correct data
    const requests = fakeApiClient.getRequests();
    const putRequest = requests.find(r => r.method === 'PUT' && r.path.includes('user-123'));
    expect(putRequest).toBeDefined();
    expect(putRequest?.data).toEqual(updates);
  });
});
```

## Testing Validation Logic

```typescript
import { describe, it, expect } from 'vitest';
import { validateShowData } from './showValidator';

describe('validateShowData', () => {
  it('should validate show data successfully', () => {
    // Given: Valid show data
    const showData = {
      ticketCount: 500,
      startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      venueId: 'venue-123'
    };

    // When: Validating
    const result = validateShowData(showData);

    // Then: Validation passes
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return errors for invalid ticket count', () => {
    // Given: Invalid ticket count
    const showData = {
      ticketCount: -10, // Invalid: negative
      startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      venueId: 'venue-123'
    };

    // When: Validating
    const result = validateShowData(showData);

    // Then: Validation fails with error
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: 'ticketCount',
        message: expect.stringContaining('positive')
      })
    );
  });

  it('should return errors for past start time', () => {
    // Given: Start time in the past
    const showData = {
      ticketCount: 500,
      startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Yesterday
      venueId: 'venue-123'
    };

    // When: Validating
    const result = validateShowData(showData);

    // Then: Validation fails
    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: 'startTime',
        message: expect.stringContaining('future')
      })
    );
  });
});
```

## Fake Implementation Examples

```typescript
// fakeShowRepository.ts
import { ShowRepository } from './showRepository';
import { Show, Venue, Act } from './types';

export class FakeShowRepository implements ShowRepository {
  private shows: Map<string, Show> = new Map();
  private venues: Map<string, Venue> = new Map();
  private acts: Map<string, Act> = new Map();

  // Initial state configuration
  withShow(show: Show): this {
    this.shows.set(show.id, show);
    return this;
  }

  withShows(shows: Show[]): this {
    shows.forEach(show => this.shows.set(show.id, show));
    return this;
  }

  withVenue(venue: Venue): this {
    this.venues.set(venue.id, venue);
    return this;
  }

  withAct(act: Act): this {
    this.acts.set(act.id, act);
    return this;
  }

  // Interface implementation
  async findById(id: string): Promise<Show | null> {
    return this.shows.get(id) ?? null;
  }

  async findByVenueId(venueId: string): Promise<Show[]> {
    return Array.from(this.shows.values())
      .filter(show => show.venueId === venueId);
  }

  async findVenueById(id: string): Promise<Venue | null> {
    return this.venues.get(id) ?? null;
  }

  async save(show: Show): Promise<Show> {
    this.shows.set(show.id, show);
    return show;
  }

  // Test helpers for assertions
  getShowCount(): number {
    return this.shows.size;
  }

  getShow(id: string): Show | undefined {
    return this.shows.get(id);
  }

  getAllShows(): Show[] {
    return Array.from(this.shows.values());
  }
}

// fakeEmailService.ts
import { EmailService } from './emailService';

interface SentEmail {
  to: string;
  subject: string;
  body: string;
}

export class FakeEmailService implements EmailService {
  private sentEmails: SentEmail[] = [];
  private shouldThrow = false;

  setShouldThrow(shouldThrow: boolean): void {
    this.shouldThrow = shouldThrow;
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    if (this.shouldThrow) {
      throw new Error('Email service unavailable');
    }
    this.sentEmails.push({ to, subject, body });
  }

  async sendBulkEmail(recipients: string[], subject: string, body: string): Promise<void> {
    if (this.shouldThrow) {
      throw new Error('Email service unavailable');
    }
    recipients.forEach(to => {
      this.sentEmails.push({ to, subject, body });
    });
  }

  // Test helpers
  getSentEmails(): SentEmail[] {
    return [...this.sentEmails];
  }

  getEmailCount(): number {
    return this.sentEmails.length;
  }

  hasEmailTo(email: string): boolean {
    return this.sentEmails.some(e => e.to === email);
  }

  clear(): void {
    this.sentEmails = [];
    this.shouldThrow = false;
  }
}
```
