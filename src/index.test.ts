import { MongoClient, Db, Collection, ObjectId } from 'mongodb'
import createSchema, { SchemaRevision, VersionedDocument, persistById, persistEmbeddedDocument } from './index'

declare global {
  namespace NodeJS {
    interface Global {
      MONGO_URI: string
      MONGO_DB_NAME: string
    }
  }
}

describe('createSchema', () => {
  let client: MongoClient
  let db: Db
  let collection: Collection

  beforeAll(async () => {
    client = await MongoClient.connect(global.MONGO_URI, { useUnifiedTopology: true })
    db = client.db(global.MONGO_DB_NAME)
    collection = await db.createCollection('test')
  })

  afterEach(async () => {
    await db.dropCollection('test')
    collection = await db.createCollection('test')
  })
   
  afterAll(async () => {
    await client.close()
  })

  it('throws an error when a bad version is returned by an updater', async () => {
    const revisions: SchemaRevision<VersionedDocument>[] = [ { update: (entity) => entity } ]
    const Schema = createSchema(revisions)

    await expect(Schema({  _v: 0 })).rejects.toThrow()
  })

  it('chains the update functions by passing them the previous return and the db instance', async () => {
    const document: VersionedDocument = { _v: 0 }

    const revisions = []
    for (let i = 0; i < 2; i++) {
      revisions.push({
        update: jest.fn().mockResolvedValue({
          ...document,
          _v: i + 1,
          ['property' + (i + 1)]: true
        })
      })
    }

    const Schema = createSchema(revisions)
    await Schema(document)
    
    for (const i in revisions) {
      const previousReturn = +i === 0
        ? document
        : await revisions[+i - 1].update.mock.results[0].value
      
      const updateFnc = revisions[i].update
      expect(updateFnc).toHaveBeenCalledTimes(1)
      expect(updateFnc).toHaveBeenCalledWith(previousReturn)
    }
  })

  it('calls the proper update functions according to the current document version', async () => {
    const document: VersionedDocument = {
      _v: 1
    }

    const revisions = [
      {
        update: jest.fn().mockReturnValue({ ...document, _v: 1 })
      },
      {
        update: jest.fn().mockReturnValue({ ...document, _v: 2 })
      }
    ]
  
    const Schema = createSchema(revisions)
  
    await Schema(document)
  
    expect(revisions[0].update).not.toHaveBeenCalled()
    expect(revisions[1].update).toHaveBeenCalledTimes(1)
  })
  
  it('returns what was returned by the last update()', async () => {
    interface D_1 extends VersionedDocument {
      oldProperty: boolean
    }

    interface D extends VersionedDocument {
      _v: 1
      newProperty: true
    }

    const oldDocument: D_1 = {
      _v: 0,
      oldProperty: true
    }

    const newDocument: D = {
      _v: 1,
      newProperty: true
    }

    const Schema = createSchema<D, D_1>([ { update: (document: D_1): D => newDocument } ])

    await expect(Schema(oldDocument)).resolves.toEqual(newDocument)
  })

  it('makes proper use of updateMany', async () => {
    const makeBatchUpdater = (propIndex: number) =>
      (documents) => documents.map(({ _v, ...document }) => ({ ...document, _v: _v + 1, updates: (document.updates || []).concat(propIndex) }))

    const revisions = [
      {
        updateMany: jest.fn(makeBatchUpdater(1))
      },
      {
        updateMany: jest.fn(makeBatchUpdater(2))
      }
    ]
    const Schema = createSchema(revisions)

    const documents: VersionedDocument[] = [
      { _v: 0 },
      { _v: 2 },
      { _v: 1 },
      { _v: 1 }
    ]

    await expect(Schema(documents)).resolves.toEqual([
      {
        _v: 2,
        updates: [ 1, 2 ]
      },
      {
        _v: 2
      },
      {
        _v: 2,
        updates: [ 2 ]
      },
      {
        _v: 2,
        updates: [ 2 ]
      }
    ])

    expect(revisions[0].updateMany).toHaveBeenCalledTimes(1)
    expect(revisions[0].updateMany).toHaveBeenCalledWith([ documents[0] ])

    expect(revisions[1].updateMany).toHaveBeenCalledTimes(1)
    expect(revisions[1].updateMany).toHaveBeenCalledWith(
      expect.arrayContaining([ documents[2], documents[3], ...revisions[0].updateMany.mock.results[0].value ])
    )
  })

  it('can persist updates to multiple documents', async () => {
    const genRand = (): Number => Math.round(Math.random() * 100) + 1

    interface D_0 extends VersionedDocument {
      _v: 0
      _id: ObjectId
      a: number
      b: number
    }

    interface D_1 extends VersionedDocument {
      _v: 1
      _id: ObjectId
      prod: number
    }

    interface D extends VersionedDocument {
      _v: 2
      _id: ObjectId
      negProd: number
    }

    await collection.insertMany(<(D | D_1 | D_0)[]>[
      {
        _v: 0,
        a: genRand(),
        b: genRand()
      },
      {
        _v: 1,
        prod: genRand()
      }
    ])

    const revisions: SchemaRevision<D_0 | D_1 | D>[] = [ {
      updateMany: (documents: D_0[]) => documents.map(({ a, b, ...document }): D_1 => ({ ...document, prod: a * b, _v: 1 }))
    }, {
      updateMany: (documents: D_1[]) => documents.map(({ prod, ...document }): D => ({ ...document, negProd: -prod, _v: 2 }))
    } ]
    const Schema = createSchema(revisions)

    const documents = await Schema(collection.find({}).toArray(), persistById(collection))

    await expect(collection.find({}).toArray()).resolves.toEqual(documents)
  })

  it('returns the value, if a falsy value is passed', async () => {
    const falsyValues = [ undefined, null, false ]
    const Schema = createSchema([])
    
    for (const value of falsyValues) {
      await expect(Schema(<any>value)).resolves.toEqual(value)
    }

    await expect(Schema(<any[]>falsyValues)).resolves.toEqual(falsyValues)
  })

  describe('persistEmbeddedDocument', () => {
    interface E_0 extends VersionedDocument {
      _v: 0
      value: number
    }

    interface E extends VersionedDocument {
      _v: 1
      dValue: number
    }

    interface D extends VersionedDocument {
      readonly _v: 0
      _id: ObjectId
      embedded: E | E_0 // testing purposes, normally only E
    }

    it('works with a single base document', async () => {
      const document: D = {
        _v: 0,
        _id: new ObjectId(),
        embedded: {
          _v: 0,
          value: Math.random() * 10 + 1
        }
      }

      const update = (document: E_0): E => ({ _v: 1, dValue: document.value * 2 })
      const EmbeddedSchema = createSchema<E, E_0>([ { update } ])

      const { insertedId } = await collection.insertOne(document)
      document._id = insertedId

      document.embedded = await EmbeddedSchema(document.embedded, persistEmbeddedDocument(collection, document, 'embedded'))

      await expect(collection.findOne({ _id: insertedId })).resolves.toEqual(document)
    })

    it('works with multiple base documents', async () => {
      let documents: D[] = [ {
        _v: 0,
        _id: new ObjectId(),
        embedded: {
          _v: 0,
          value: Math.random() * 10 + 1
        }
      }, {
        _v: 0,
        _id: new ObjectId(),
        embedded: {
          _v: 0,
          value: Math.random() * 10 + 1
        }
      } ]

      const update = (document: E_0): E => ({ _v: 1, dValue: document.value * 2 })
      const EmbeddedSchema = createSchema<E, E_0>([ { update } ])

      const { insertedIds } = await collection.insertMany(documents)
      documents = documents.map((document: D, index: number) => ({ ...document, _id: insertedIds[index] }))

      const embeddedDocs = await EmbeddedSchema(documents.map(({ embedded }) => embedded), persistEmbeddedDocument(collection, documents, 'embedded'))
      documents = documents.map((document: D, index: number) => ({ ...document, embedded: embeddedDocs[index] }))

      await expect(collection.find({ _id: { $in: documents.map(({ _id }) => _id ) } }).toArray()).resolves.toEqual(documents)
    })
  })
})
