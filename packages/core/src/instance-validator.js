'use strict';

import { AbstractDataType } from './dialects/abstract/data-types';
import { validateDataType } from './dialects/abstract/data-types-utils';
import { BaseSqlExpression } from './expression-builders/base-sql-expression.js';
import { getAllOwnKeys } from './utils/object';
import { BelongsTo } from './associations/belongs-to';

const _ = require('lodash');
const sequelizeError = require('./errors');
const validator = require('./utils/validator-extras').validator;
const { promisify } = require('node:util');

/**
 * Instance Validator.
 *
 * @param {Instance} modelInstance The model instance.
 * @param {object} options A dictionary with options.
 *
 * @private
 */
export class InstanceValidator {
  constructor(modelInstance, options) {
    options = {
      // assign defined and default options
      hooks: true,
      ...options,
    };

    if (options.fields && !options.skip) {
      options.skip = _.difference(Array.from(modelInstance.constructor.modelDefinition.attributes.keys()), options.fields);
    } else {
      options.skip ??= [];
    }

    this.options = options;

    this.modelInstance = modelInstance;

    /**
     * Exposes a reference to validator.js. This allows you to add custom validations using `validator.extend`
     *
     * @name validator
     * @private
     */
    this.validator = validator;

    /**
     *  All errors will be stored here from the validations.
     *
     * @type {Array} Will contain keys that correspond to attributes which will
     *   be Arrays of Errors.
     * @private
     */
    this.errors = [];

    /**
     * @type {boolean} Indicates if validations are in progress
     * @private
     */
    this.inProgress = false;
  }

  /**
   * The main entry point for the Validation module, invoke to start the dance.
   *
   * @returns {Promise}
   * @private
   */
  async _validate() {
    if (this.inProgress) {
      throw new Error('Validations already in progress.');
    }

    this.inProgress = true;

    await Promise.all([
      this._perAttributeValidators(),
      this._customValidators(),
    ]);

    if (this.errors.length > 0) {
      throw new sequelizeError.ValidationError(null, this.errors);
    }
  }

  /**
   * Invoke the Validation sequence and run validation hooks if defined
   *   - Before Validation Model Hooks
   *   - Validation
   *   - On validation success: After Validation Model Hooks
   *   - On validation failure: Validation Failed Model Hooks
   *
   * @returns {Promise}
   * @private
   */
  async validate() {
    return await (this.options.hooks ? this._validateAndRunHooks() : this._validate());
  }

  /**
   * Invoke the Validation sequence and run hooks
   *   - Before Validation Model Hooks
   *   - Validation
   *   - On validation success: After Validation Model Hooks
   *   - On validation failure: Validation Failed Model Hooks
   *
   * @returns {Promise}
   * @private
   */
  async _validateAndRunHooks() {
    await this.modelInstance.constructor.hooks.runAsync('beforeValidate', this.modelInstance, this.options);

    try {
      await this._validate();
    } catch (error) {
      const newError = await this.modelInstance.constructor.hooks.runAsync('validationFailed', this.modelInstance, this.options, error);
      throw newError || error;
    }

    await this.modelInstance.constructor.hooks.runAsync('afterValidate', this.modelInstance, this.options);

    return this.modelInstance;
  }

  /**
   * Will run all the validators defined per attribute (built-in validators and custom validators)
   *
   * @returns {Promise<Array>}
   * @private
   */
  async _perAttributeValidators() {
    // promisify all attribute invocations
    const validators = [];

    const { attributes } = this.modelInstance.constructor.modelDefinition;

    for (const attribute of attributes.values()) {
      const attrName = attribute.attributeName;

      if (this.options.skip.includes(attrName)) {
        continue;
      }

      const value = this.modelInstance.dataValues[attrName];

      if (value instanceof BaseSqlExpression) {
        continue;
      }

      if (!attribute._autoGenerated && !attribute.autoIncrement) {
        // perform validations based on schema
        this._validateSchema(attribute, attrName, value);
      }

      if (attribute.validate) {
        validators.push(this._singleAttrValidate(value, attrName, attribute.allowNull));
      }
    }

    return await Promise.all(validators);
  }

  /**
   * Will run all the custom validators defined in the model's options.
   *
   * @returns {Promise<Array>}
   * @private
   */
  async _customValidators() {
    const validators = [];

    const validateOptions = this.modelInstance.constructor.options.validate;

    for (const validatorName of getAllOwnKeys(validateOptions)) {
      if (this.options.skip.includes(validatorName)) {
        continue;
      }

      const validator = validateOptions[validatorName];

      const valprom = this._invokeCustomValidator(validator, validatorName)
        // errors are handled in settling, stub this
        .catch(() => {});

      validators.push(valprom);
    }

    return await Promise.all(validators);
  }

  /**
   * Validate a single attribute with all the defined built-in validators and custom validators.
   *
   * @private
   *
   * @param {*} value Anything.
   * @param {string} attributeName The attribute name.
   * @param {boolean} allowNull Whether or not the schema allows null values
   *
   * @returns {Promise} A promise, will always resolve, auto populates error on this.error local object.
   */
  async _singleAttrValidate(value, attributeName, allowNull) {
    // If value is null and allowNull is false, no validators should run (see #9143)
    if (value == null && !allowNull) {
      // The schema validator (_validateSchema) has already generated the validation error. Nothing to do here.
      return;
    }

    // Promisify each validator
    const validators = [];

    const attribute = this.modelInstance.constructor.modelDefinition.attributes.get(attributeName);

    _.forIn(attribute.validate, (test, validatorType) => {
      if (['isUrl', 'isURL', 'isEmail'].includes(validatorType)) {
        // Preserve backwards compat. Validator.js now expects the second param to isURL and isEmail to be an object
        if (typeof test === 'object' && test !== null && test.msg) {
          test = {
            msg: test.msg,
          };
        } else if (test === true) {
          test = {};
        }
      }

      // Custom validators should always run, except if value is null and allowNull is false (see #9143)
      if (typeof test === 'function') {
        validators.push(this._invokeCustomValidator(test, validatorType, true, value, attributeName));

        return;
      }

      // If value is null, built-in validators should not run (only custom validators have to run) (see #9134).
      if (value === null || value === undefined) {
        return;
      }

      const validatorPromise = this._invokeBuiltinValidator(value, test, validatorType, attributeName);
      // errors are handled in settling, stub this
      validatorPromise.catch(() => {});
      validators.push(validatorPromise);
    });

    return Promise
      .all(validators.map(validator => validator.catch(error => {
        const isBuiltIn = Boolean(error.validatorName);
        this._pushError(isBuiltIn, attributeName, error, value, error.validatorName, error.validatorArgs);
      })));
  }

  /**
   * Prepare and invoke a custom validator.
   *
   * @private
   *
   * @param {Function} validator The custom validator.
   * @param {string} validatorType the custom validator type (name).
   * @param {boolean} optAttrDefined Set to true if custom validator was defined from the attribute
   * @param {*} optValue value for attribute
   * @param {string} optField field for attribute
   *
   * @returns {Promise} A promise.
   */
  async _invokeCustomValidator(validator, validatorType, optAttrDefined, optValue, optField) {
    let isAsync = false;

    const validatorArity = validator.length;
    // check if validator is async and requires a callback
    let asyncArity = 1;
    let errorKey = validatorType;
    let invokeArgs;
    if (optAttrDefined) {
      asyncArity = 2;
      invokeArgs = optValue;
      errorKey = optField;
    }

    if (validatorArity === asyncArity) {
      isAsync = true;
    }

    // TODO [>7]: validators should receive their model as the first argument, not through "this".
    //  Only exception to this is the @ModelValidator decorator when used on an instance method, but it is responsible for that
    //  behavior, not this!
    if (isAsync) {
      try {
        if (optAttrDefined) {
          return await promisify(validator.bind(this.modelInstance, invokeArgs))();
        }

        return await promisify(validator.bind(this.modelInstance))();
      } catch (error) {
        return this._pushError(false, errorKey, error, optValue, validatorType);
      }
    }

    try {
      return await validator.call(this.modelInstance, invokeArgs);
    } catch (error) {
      return this._pushError(false, errorKey, error, optValue, validatorType);
    }
  }

  /**
   * Prepare and invoke a build-in validator.
   *
   * @private
   *
   * @param {*} value Anything.
   * @param {*} test The test case.
   * @param {string} validatorType One of known to Sequelize validators.
   * @param {string} field The field that is being validated
   *
   * @returns {object} An object with specific keys to invoke the validator.
   */
  async _invokeBuiltinValidator(value, test, validatorType, field) {
    // Cast value as string to pass new Validator.js string requirement
    const valueString = String(value);
    // check if Validator knows that kind of validation test
    if (typeof validator[validatorType] !== 'function') {
      throw new TypeError(`Invalid validator function: ${validatorType}`);
    }

    const validatorArgs = this._extractValidatorArgs(test, validatorType, field);

    if (!validator[validatorType](valueString, ...validatorArgs)) {
      throw Object.assign(new Error(test.msg || `Validation ${validatorType} on ${field} failed`), { validatorName: validatorType, validatorArgs });
    }
  }

  /**
   * Will extract arguments for the validator.
   *
   * @param {*} test The test case.
   * @param {string} validatorType One of known to Sequelize validators.
   * @param {string} field The field that is being validated.
   *
   * @private
   */
  _extractValidatorArgs(test, validatorType, field) {
    let validatorArgs = test.args || test;
    const isLocalizedValidator = typeof validatorArgs !== 'string' && ['isAlpha', 'isAlphanumeric', 'isMobilePhone'].includes(validatorType);

    if (!Array.isArray(validatorArgs)) {
      if (validatorType === 'isImmutable') {
        validatorArgs = [validatorArgs, field, this.modelInstance];
      } else if (isLocalizedValidator || validatorType === 'isIP') {
        validatorArgs = [];
      } else {
        validatorArgs = [validatorArgs];
      }
    } else {
      validatorArgs = [...validatorArgs];
    }

    return validatorArgs;
  }

  /**
   * Will validate a single field against its schema definition (isnull).
   *
   * @param {object} attribute As defined in the Schema.
   * @param {string} attributeName The field name.
   * @param {*} value anything.
   *
   * @private
   */
  _validateSchema(attribute, attributeName, value) {
    if (attribute.allowNull === false && value == null) {
      const association = Object.values(this.modelInstance.constructor.associations).find(association => association instanceof BelongsTo && association.foreignKey === attribute.fieldName);
      if (!association || !this.modelInstance.get(association.as)) {
        const modelDefinition = this.modelInstance.constructor.modelDefinition;
        const validators = modelDefinition.attributes.get(attributeName)?.validate;
        const errMsg = _.get(validators, 'notNull.msg', `${this.modelInstance.constructor.name}.${attributeName} cannot be null`);

        this.errors.push(new sequelizeError.ValidationErrorItem(
          errMsg,
          'notNull violation', // sequelizeError.ValidationErrorItem.Origins.CORE,
          attributeName,
          value,
          this.modelInstance,
          'is_null',
        ));
      }
    }

    const type = attribute.type;
    if (value != null && !(value instanceof BaseSqlExpression) && type instanceof AbstractDataType) {
      const error = validateDataType(value, type, attributeName, this.modelInstance);
      if (error) {
        this.errors.push(error);
      }
    }
  }

  /**
   * Signs all errors retaining the original.
   *
   * @param {boolean}       isBuiltin   - Determines if error is from builtin validator.
   * @param {string}        errorKey    - name of invalid attribute.
   * @param {Error|string}  rawError    - The original error.
   * @param {string|number} value       - The data that triggered the error.
   * @param {string}        fnName      - Name of the validator, if any
   * @param {Array}         fnArgs      - Arguments for the validator [function], if any
   *
   * @private
   */
  _pushError(isBuiltin, errorKey, rawError, value, fnName, fnArgs) {
    const message = rawError.message || rawError || 'Validation error';
    const error = new sequelizeError.ValidationErrorItem(
      message,
      'Validation error', // sequelizeError.ValidationErrorItem.Origins.FUNCTION,
      errorKey,
      value,
      this.modelInstance,
      fnName,
      isBuiltin ? fnName : undefined,
      isBuiltin ? fnArgs : undefined,
    );

    error[InstanceValidator.RAW_KEY_NAME] = rawError;

    this.errors.push(error);
  }
}

/**
 * The error key for arguments as passed by custom validators
 *
 * @type {string}
 * @private
 */
InstanceValidator.RAW_KEY_NAME = 'original';
